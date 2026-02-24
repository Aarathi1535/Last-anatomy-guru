
import React, { useState, useEffect } from 'react';
import { generateStructuredFeedback, EvaluationMode } from './services/geminiService';
import { EvaluationReport, FileData } from './types';
import FileUploader from './components/FileUploader';
import FeedbackReport from './components/FeedbackReport';
// @ts-ignore
import mammoth from 'mammoth';
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, Footer, PageNumber, NumberFormat } from 'docx';

const pdfjs: any = (pdfjsLib as any).GlobalWorkerOptions 
  ? pdfjsLib 
  : (pdfjsLib as any).default || pdfjsLib;

if (pdfjs && pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.624/pdf.worker.min.mjs`;
}

const App: React.FC = () => {
  const [sourceDoc, setSourceDoc] = useState<File | null>(null);
  const [dirtyFeedbackDoc, setDirtyFeedbackDoc] = useState<File | null>(null);
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'dashboard' | 'report' | 'history'>('dashboard');
  const [evalMode, setEvalMode] = useState<EvaluationMode>('with-manual');
  const [history, setHistory] = useState<EvaluationReport[]>([]);

  useEffect(() => {
    const savedHistory = localStorage.getItem('evaluation_history');
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('evaluation_history', JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (report) setView('report');
  }, [report]);

  const extractTextFromPDF = async (file: File): Promise<string> => {
    if (!pdfjs || !pdfjs.getDocument) {
      throw new Error("PDF processing library not initialized.");
    }
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let fullText = '';
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      fullText += `[P${i}] ${pageText}\n`;
    }
    return fullText;
  };

  const processFile = async (file: File): Promise<FileData> => {
    const fileName = file.name.toLowerCase();
    const isDocx = fileName.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isPdf = fileName.endsWith('.pdf') || file.type === 'application/pdf';
    
    if (isDocx) {
      setLoadingStep(`Analyzing DOCX: ${file.name}`);
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return { text: result.value, name: file.name, isDocx: true };
    } 
    
    if (isPdf) {
      setLoadingStep(`Extracting PDF Text: ${file.name}`);
      try {
        const text = await extractTextFromPDF(file);
        if (text.trim().length > 100) {
          return { text, name: file.name, isDocx: false };
        }
      } catch (e) {
        console.warn("Falling back to visual OCR mode for PDF", e);
      }
    }

    setLoadingStep(`Preparing Visual Data: ${file.name}`);
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
    });

    return {
      base64,
      mimeType: file.type || 'image/jpeg',
      name: file.name,
      isDocx: false
    };
  };

  const handleAnalyze = async () => {
    if (!sourceDoc) {
      setError("Please upload the Student Answer Sheet.");
      return;
    }
    if (evalMode === 'with-manual' && !dirtyFeedbackDoc) {
      setError("Faculty Notes are required for 'Manual Feedback' mode.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      setLoadingStep("Reading documents...");
      const sourceData = await processFile(sourceDoc);
      const feedbackData = evalMode === 'with-manual' && dirtyFeedbackDoc 
        ? await processFile(dirtyFeedbackDoc) 
        : null;

      setLoadingStep("AI Medical Auditor is evaluating content...");
      const result = await generateStructuredFeedback(sourceData, feedbackData, evalMode);
      setReport(result);
      setHistory(prev => [result, ...prev]);
    } catch (err: any) {
      console.error("Medical Audit Failed:", err);
      setError(err.message || "An unexpected error occurred during medical evaluation.");
    } finally {
      setIsLoading(false);
      setLoadingStep('');
    }
  };

  const handleExportPDF = () => {
    window.print();
  };

  const handleNewAnalysis = () => {
    setSourceDoc(null);
    setDirtyFeedbackDoc(null);
    setReport(null);
    setError(null);
    setView('dashboard');
  };

  const handleExportWord = async () => {
    if (!report) return;

    const sections = [];
    sections.push(
      new Paragraph({
        children: [new TextRun(report.testTitle || 'Medical Evaluation Report')],
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({ children: [new TextRun({ text: `Student: ${report.studentName}`, bold: true })] }),
      new Paragraph({ children: [new TextRun({ text: `Date: ${report.testDate}`, bold: true })] }),
      new Paragraph({ children: [] }) 
    );

    const tableRows = [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Q No", bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Feedback", bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Marks", bold: true })] })] }),
        ],
      }),
    ];

    report.questions.forEach((q) => {
      tableRows.push(
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun(q.qNo)] })] }),
            new TableCell({ children: q.feedbackPoints.map(p => new Paragraph({ children: [new TextRun("• " + p)] })) }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(`${q.marks}/${q.maxMarks}`)] })] }),
          ],
        })
      );
    });

    sections.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }));

    // Add Audit Trail if there are flagged questions
    const flagged = report.questions.filter(q => q.isFlagged);
    if (flagged.length > 0) {
      sections.push(
        new Paragraph({ children: [], spacing: { before: 400 } }),
        new Paragraph({
          children: [new TextRun({ text: "AUDIT TRAIL: RESOLUTION OF CONTRADICTIONS", bold: true })],
          heading: HeadingLevel.HEADING_2,
        }),
        new Paragraph({
          children: [new TextRun({ text: "The following questions showed a significant contradiction between the Faculty Notes and the official Answer Key. The system has prioritized the Answer Key for the final report.", italics: true, size: 20 })],
        })
      );

      flagged.forEach(q => {
        sections.push(
          new Paragraph({ children: [new TextRun({ text: `Question ${q.qNo}`, bold: true })], spacing: { before: 200 } }),
          new Paragraph({ children: [new TextRun({ text: "Original Faculty Observation:", bold: true, size: 18 })] }),
          ...q.feedbackPoints.map(p => new Paragraph({ children: [new TextRun({ text: `• ${p}`, size: 18 })] })),
          new Paragraph({ children: [new TextRun({ text: "Auditor's Resolution:", bold: true, size: 18, color: "8B4513" })] }),
          new Paragraph({ children: [new TextRun({ text: q.flaggedComment || "N/A", size: 18, color: "8B4513" })] })
        );
      });
    }

    const doc = new Document({
      sections: [{
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun("Page "),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                  }),
                  new TextRun(" of "),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                  }),
                ],
              }),
            ],
          }),
        },
        children: sections,
      }],
    });
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `AnatomyGuru_${report.studentName || 'Report'}.docx`;
    link.click();
  };

  const renderDashboard = () => (
    <div className="max-w-4xl mx-auto px-4 mt-16 animate-fade-in pb-20">
      <header className="text-center mb-12">
        <h1 className="text-5xl font-black text-slate-900 mb-4 tracking-tight">
          Medical <span className="text-red-600">Evaluation</span>
        </h1>
        <p className="text-slate-500 font-medium text-lg max-w-2xl mx-auto">
          Professional medical audit engine. Processes complex reports with clinical precision.
        </p>
      </header>

      <div className="flex justify-center mb-10">
        <div className="bg-slate-200/50 p-1 rounded-xl flex items-center shadow-inner">
          <button 
            onClick={() => setEvalMode('with-manual')}
            className={`px-5 py-2 rounded-lg font-bold text-sm transition-all ${evalMode === 'with-manual' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
          >
            With Faculty Notes
          </button>
          <button 
            onClick={() => setEvalMode('without-manual')}
            className={`px-5 py-2 rounded-lg font-bold text-sm transition-all ${evalMode === 'without-manual' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
          >
            Automated Key Only
          </button>
        </div>
      </div>

      <div className={`grid gap-6 mb-10 ${evalMode === 'with-manual' ? 'md:grid-cols-2' : 'max-w-md mx-auto'}`}>
        <FileUploader
          label="Student Answer Sheet"
          description="PDF/DOCX containing Key + Answers"
          onFileSelect={setSourceDoc}
          selectedFile={sourceDoc}
          icon={<svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>}
        />
        {evalMode === 'with-manual' && (
          <FileUploader
            label="Faculty Notes"
            description="Scanned handwritten feedback/marks"
            onFileSelect={setDirtyFeedbackDoc}
            selectedFile={dirtyFeedbackDoc}
            icon={<svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>}
          />
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl mb-8 flex items-center gap-3 animate-pulse">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd"></path></svg>
          <p className="text-sm font-semibold">{error}</p>
        </div>
      )}

      <button
        onClick={handleAnalyze}
        disabled={isLoading || !sourceDoc || (evalMode === 'with-manual' && !dirtyFeedbackDoc)}
        className={`w-full py-5 rounded-2xl font-bold text-lg shadow-xl transition-all flex flex-col items-center justify-center ${
          isLoading 
          ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200' 
          : 'bg-slate-900 hover:bg-black text-white hover:-translate-y-1'
        }`}
      >
        {isLoading ? (
          <>
            <div className="flex items-center gap-3">
              <svg className="animate-spin h-5 w-5 text-red-500" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
              <span>{loadingStep}</span>
            </div>
          </>
        ) : (
          "Run Medical Audit"
        )}
      </button>
    </div>
  );

  const renderHistory = () => (
    <div className="max-w-4xl mx-auto px-4 mt-16 animate-fade-in pb-20">
      <header className="text-center mb-12">
        <h1 className="text-5xl font-black text-slate-900 mb-4 tracking-tight">
          Evaluation <span className="text-red-600">History</span>
        </h1>
        <p className="text-slate-500 font-medium text-lg max-w-2xl mx-auto">
          Review previous medical audits and student performance reports.
        </p>
      </header>

      {history.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-3xl border border-slate-200 shadow-sm">
          <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-10 h-10 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          </div>
          <h3 className="text-xl font-bold text-slate-900 mb-2">No History Found</h3>
          <p className="text-slate-500 mb-8">You haven't performed any medical audits yet.</p>
          <button 
            onClick={() => setView('dashboard')}
            className="px-8 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-black transition-all"
          >
            Start New Analysis
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {history.map((h, idx) => (
            <div 
              key={idx} 
              className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all cursor-pointer flex items-center justify-between group"
              onClick={() => {
                setReport(h);
                setView('report');
              }}
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-red-50 rounded-xl flex items-center justify-center text-red-600 font-black text-lg">
                  {h.totalScore}
                </div>
                <div>
                  <h3 className="font-black text-slate-900 group-hover:text-red-600 transition-colors">{h.studentName}</h3>
                  <p className="text-sm text-slate-500 font-medium">{h.testTitle} • {h.testDate}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{h.testTopics}</span>
                <svg className="w-5 h-5 text-slate-300 group-hover:text-slate-900 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
              </div>
            </div>
          ))}
          <button 
            onClick={() => {
              if (confirm("Are you sure you want to clear all history?")) {
                setHistory([]);
                localStorage.removeItem('evaluation_history');
              }
            }}
            className="w-full py-4 text-slate-400 hover:text-red-600 font-bold text-sm transition-colors"
          >
            Clear History
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white/80 backdrop-blur-md border-b border-slate-200 sticky top-0 z-50 no-print h-16">
        <div className="max-w-7xl mx-auto px-4 h-full flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <span className="brand-font text-xl font-black text-slate-800 tracking-tighter"><span className="text-red-600"></span></span>
            </div>
            
            <div className="hidden md:flex items-center gap-1">
              <button 
                onClick={() => setView('dashboard')}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${view === 'dashboard' ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}
              >
                Dashboard
              </button>
              <button 
                onClick={() => setView('history')}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${view === 'history' ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}
              >
                History
              </button>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {view === 'report' && report && (
              <>
                <button onClick={handleNewAnalysis} className="px-4 py-2 text-slate-600 hover:text-slate-900 text-xs font-bold transition-all mr-2">New Analysis</button>
                <button onClick={handleExportWord} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/20 transition-all">Export Word</button>
                <button onClick={handleExportPDF} className="px-4 py-2 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700 shadow-lg shadow-red-500/20 transition-all">Print PDF</button>
              </>
            )}
            {view !== 'report' && (
               <button 
                onClick={handleNewAnalysis}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-black transition-all"
               >
                 New Analysis
               </button>
            )}
          </div>
        </div>
      </nav>

      <main>
        {view === 'dashboard' && renderDashboard()}
        {view === 'history' && renderHistory()}
        {view === 'report' && <FeedbackReport report={report} onNewAnalysis={handleNewAnalysis} />}
      </main>
    </div>
  );
};

export default App;
