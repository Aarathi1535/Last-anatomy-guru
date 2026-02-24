
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { EvaluationReport, FileData } from "../types";

export type EvaluationMode = 'with-manual' | 'without-manual';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 2000;
const REQUEST_TIMEOUT = 120000; // 120 seconds

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Helper to call Gemini with retry logic and timeout
 */
const callGeminiWithRetry = async (
  ai: any,
  model: string,
  contents: any[],
  systemInstruction: string,
  schema: any,
  label: string
): Promise<string> => {
  let lastError: any;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const generatePromise = ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: schema,
        }
      });

      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`${label} Timeout: The model took too long to respond.`)), REQUEST_TIMEOUT)
      );

      const response: GenerateContentResponse = await Promise.race([generatePromise, timeoutPromise]);
      const text = response.text;
      
      if (!text) {
        throw new Error(`${label} failed: No response from AI.`);
      }
      
      return text;
    } catch (error: any) {
      lastError = error;
      console.error(`${label} Attempt ${attempt + 1} failed:`, error);

      const isRetryable = 
        error.message?.includes("429") || 
        error.message?.includes("500") || 
        error.message?.includes("503") || 
        error.message?.includes("Timeout") ||
        error.message?.includes("fetch") ||
        error.message?.includes("API key not valid");

      if (isRetryable && attempt < MAX_RETRIES - 1) {
        const backoff = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
        await wait(backoff);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

/**
 * Simple concurrency limiter
 */
async function mapParallel<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];
  for (const item of items) {
    const p = fn(item).then(res => {
      results.push(res);
    });
    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
      // Remove finished promises
      for (let i = 0; i < executing.length; i++) {
        // @ts-ignore - checking promise state is tricky, we just filter by what's done
      }
      // A simpler way for this environment:
      const finished = await Promise.all(executing.map(p => Promise.race([p, 'pending'])));
      for (let i = executing.length - 1; i >= 0; i--) {
        if (finished[i] !== 'pending') executing.splice(i, 1);
      }
    }
  }
  await Promise.all(executing);
  return results;
}

export const generateStructuredFeedback = async (
  sourceDoc: FileData,
  dirtyFeedbackDoc: FileData | null,
  mode: EvaluationMode = 'with-manual'
): Promise<EvaluationReport> => {
  const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error("Medical Audit Configuration Error: API Key is missing.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const createPart = (data: FileData | null, label: string) => {
    if (!data) return [{ text: `${label}: Not provided.` }];
    if (data.text) {
      return [{ text: `DOCUMENT_START: ${label}\n${data.text}\nDOCUMENT_END: ${label}` }];
    } else if (data.base64 && data.mimeType) {
      return [
        { text: `DOCUMENT_START: ${label} (Visual/Image Data)` },
        { inlineData: { data: data.base64, mimeType: data.mimeType } },
        { text: `DOCUMENT_END: ${label}` }
      ];
    }
    return [{ text: `${label}: No usable content found.` }];
  };

  const contentsParts: any[] = [...createPart(sourceDoc, "STUDENT_ANSWER_SCRIPT_AND_KEY")];
  if (mode === 'with-manual' && dirtyFeedbackDoc) {
    contentsParts.push(...createPart(dirtyFeedbackDoc, "FACULTY_MANUAL_FEEDBACK"));
  }

  // PHASE 0: DOCUMENT STRUCTURING
  const structuringInstruction = `
    You are a medical document parser.
    From the given text/image:
    - Extract all questions
    - Extract student answers
    - Extract answer key (if present)
    - Extract any evaluator comments

    STRICT CONSTRAINT: Do NOT guess unclear words. If any text is unclear or unreadable, do not infer meaning. Report it as [unreadable].

    Return JSON:
    [
      {
        "qNo": "",
        "question": "",
        "studentAnswer": "",
        "answerKey": "",
        "facultyMarks": 0,
        "facultyFeedback": ""
      }
    ]
  `;
  const structuringSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        qNo: { type: Type.STRING },
        question: { type: Type.STRING },
        studentAnswer: { type: Type.STRING },
        answerKey: { type: Type.STRING },
        facultyMarks: { type: Type.NUMBER, description: "The marks assigned by the faculty for this question. If not found, use 0." },
        facultyFeedback: { type: Type.STRING }
      },
      required: ["qNo", "question", "studentAnswer", "answerKey", "facultyMarks", "facultyFeedback"]
    }
  };

  const structuredDataJson = await callGeminiWithRetry(
    ai,
    "gemini-flash-lite-latest",
    [{ parts: [...contentsParts, { text: "Structure the document into questions and answers." }] }],
    structuringInstruction,
    structuringSchema,
    "Phase 0: Structuring"
  );
  const structuredQuestions = JSON.parse(structuredDataJson);

  // PHASE 1: DISCOVERY (Metadata only)
  const discoveryInstruction = `
    You are a medical document parser. Extract the test metadata.
    OUTPUT: JSON only.
  `;
  const discoverySchema = {
    type: Type.OBJECT,
    properties: {
      studentName: { type: Type.STRING },
      testTitle: { type: Type.STRING },
      testTopics: { type: Type.STRING },
      testDate: { type: Type.STRING },
      maxScore: { type: Type.NUMBER }
    },
    required: ["studentName", "testTitle", "testTopics", "testDate", "maxScore"]
  };

  const discoveryJson = await callGeminiWithRetry(
    ai,
    "gemini-flash-lite-latest",
    [{ parts: [...contentsParts, { text: "Extract test metadata." }] }],
    discoveryInstruction,
    discoverySchema,
    "Discovery Phase"
  );
  const metadata = JSON.parse(discoveryJson);

  // PHASE 2: PARALLEL EVALUATION
  const verificationInstruction = `
    You are the "Anatomy Guru Master Evaluator", a high-precision medical academic auditor.
    Your mission is to perform a raw audit of human faculty feedback for the SPECIFIED QUESTION ONLY using the provided structured data.

    STRICT EVALUATION: Be extremely strict. Accuracy is paramount.
    PRIORITIZE MANUAL FEEDBACK: You MUST strictly obey the 'facultyFeedback' and 'facultyMarks' as the primary source of truth for evaluation intent. Do not ignore or bypass them.
    MARKING BASELINE: You MUST use the 'facultyMarks' as the absolute starting baseline.
    DO NOT ADD EXTRA MARKS: Do not increase the marks beyond 'facultyMarks' unless there is a blatant mathematical error in the faculty's calculation.
    TOUCH MARKS ONLY ON CONTRADICTION: You MUST only modify the marks if the faculty's evaluation contradicts the official Answer Key (e.g., faculty gave marks for a medically incorrect answer). In such cases, deduct marks to match medical accuracy.
    STRICT CONSTRAINT: Do NOT guess unclear words. If any text is unclear or unreadable, do not infer meaning.
    NO "STUDENT" WORD: Do NOT use the word "student" in any part of the feedback or comments. Refer to the work directly (e.g., "The answer...", "The diagram...", "The script...").

    STRICT WORKFLOW (Follow for the SPECIFIED question):
    1. ANALYZE MANUAL FEEDBACK: First, strictly consider the 'facultyFeedback' and 'facultyMarks'. This is your primary guide.
    2. VERIFY WITH SCRIPT: Then, verify the faculty's claims against the 'studentAnswer' (the script).
    3. VALIDATE AGAINST ANSWER KEY: Finally, validate everything against the 'answerKey' (The Absolute Truth).
    4. DETECT FALSE POSITIVES: Be extremely vigilant. If the human evaluator marked a wrong/incomplete answer as "Correct", you MUST override it, flag the question (isFlagged: true), and provide corrected marks/feedback.
    5. RESOLVE CONTRADICTIONS: Prioritize the Answer Key and physical evidence over faculty judgment ONLY when they conflict.

    CRITICAL CONSTRAINTS:
    - UNATTEMPTED QUESTIONS: If the studentAnswer is empty or indicates no attempt, include 0 marks. The feedbackPoints MUST include "Question not attempted" followed by a concise 2-liner summary of the key points that should have been written according to the Answer Key.
    - NO HALLUCINATION: Only report what is physically present.
    - MARKS: Deduct marks for any missing key points defined in the Answer Key.
    - MODE: ${mode}.
  `;
  const questionSchema = {
    type: Type.OBJECT,
    properties: {
      qNo: { type: Type.STRING },
      feedbackPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
      marks: { type: Type.NUMBER },
      maxMarks: { type: Type.NUMBER },
      isCorrect: { type: Type.BOOLEAN },
      isFlagged: { type: Type.BOOLEAN },
      flaggedComment: { type: Type.STRING, description: "If isFlagged is true, provide a brief explanation of the contradiction resolved (e.g., 'Corrected from faculty's 5 marks to 2 marks')." }
    },
    required: ["qNo", "feedbackPoints", "marks", "maxMarks", "isCorrect"]
  };

  const evaluateQuestion = async (qData: any) => {
    const { qNo } = qData;
    
    const rawAudit = await callGeminiWithRetry(
      ai,
      "gemini-flash-lite-latest",
      [{ parts: [{ text: `STRUCTURED_QUESTION_DATA: ${JSON.stringify(qData)}\n\nPerform raw audit for Question Number: ${qNo}. Follow the STRICT WORKFLOW.` }] }],
      verificationInstruction,
      questionSchema,
      `Question ${qNo} Verification`
    );
    
    const feedbackInstruction = `
      You are the "Anatomy Guru Master Evaluator". Refine the raw audit findings for the SPECIFIED QUESTION to generate the final enhanced feedback.

      STRICT EVALUATION: Maintain the strictness of the raw audit. Ensure marks reflect the medical accuracy and completeness.
      MARKING INTEGRITY: Use the marks from the raw audit, which should be based on the faculty baseline. Do not add extra marks.
      STRICT CONSTRAINT: Do NOT guess unclear words. If any text is unclear or unreadable, do not infer meaning.
      NO "STUDENT" WORD: Do NOT use the word "student" in the 'feedbackPoints' or 'flaggedComment'. Use neutral, professional language.

      STRICT WORKFLOW:
      6. GENERATE ENHANCED FEEDBACK: Create a final report that preserves valid insights but corrects any errors in judgment.

      CRITICAL CONSTRAINTS:
      - NO "FACULTY" MENTION: Do NOT use the word "faculty" or "evaluator" in the 'feedbackPoints' array.
      - CONTRADICTION ISOLATION: If a contradiction is resolved, the 'feedbackPoints' must contain ONLY the final, corrected, and medically accurate feedback. The mention of the contradiction itself MUST be restricted to the 'flaggedComment' field only.
      - TYPOGRAPHY: Use **bold** ONLY for critical medical terms.
      - MODE: ${mode}.
    `;
    
    const finalQuestionJson = await callGeminiWithRetry(
      ai,
      "gemini-flash-latest",
      [{ parts: [{ text: `RAW_QUESTION_DATA: ${rawAudit}\n\nGenerate final refined feedback for this question.` }] }],
      feedbackInstruction,
      questionSchema,
      `Question ${qNo} Feedback`
    );
    
    return JSON.parse(finalQuestionJson);
  };

  // Process questions with concurrency limit of 3
  const questionResults = await mapParallel(structuredQuestions, 3, evaluateQuestion);

  // Sort questions by qNo in ascending order
  questionResults.sort((a, b) => a.qNo.localeCompare(b.qNo, undefined, { numeric: true, sensitivity: 'base' }));

  // PHASE 3: SYNTHESIS
  const synthesisInstruction = `
    Generate the general feedback section based on the evaluated questions.
    STRICT EVALUATION: Maintain strictness.
    MODE: ${mode}.
  `;
  const synthesisSchema = {
    type: Type.OBJECT,
    properties: {
      generalFeedback: {
        type: Type.OBJECT,
        properties: {
          overallPerformance: { type: Type.ARRAY, items: { type: Type.STRING } },
          mcqs: { type: Type.ARRAY, items: { type: Type.STRING } },
          contentAccuracy: { type: Type.ARRAY, items: { type: Type.STRING } },
          completenessOfAnswers: { type: Type.ARRAY, items: { type: Type.STRING } },
          presentationDiagrams: { type: Type.ARRAY, items: { type: Type.STRING } },
          investigations: { type: Type.ARRAY, items: { type: Type.STRING } },
          attemptingQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
          actionPoints: { type: Type.ARRAY, items: { type: Type.STRING } }
        },
        required: ["overallPerformance", "mcqs", "contentAccuracy", "completenessOfAnswers", "presentationDiagrams", "investigations", "attemptingQuestions", "actionPoints"]
      }
    },
    required: ["generalFeedback"]
  };

  const synthesisJson = await callGeminiWithRetry(
    ai,
    "gemini-flash-latest",
    [{ parts: [{ text: `QUESTION_RESULTS: ${JSON.stringify(questionResults)}\n\nGenerate general feedback.` }] }],
    synthesisInstruction,
    synthesisSchema,
    "Synthesis Phase"
  );
  const synthesis = JSON.parse(synthesisJson);

  const totalScore = questionResults.reduce((acc, q) => acc + (q.marks || 0), 0);

  return {
    ...metadata,
    totalScore,
    questions: questionResults,
    generalFeedback: synthesis.generalFeedback
  };
};
