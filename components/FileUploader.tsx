
import React from 'react';

interface FileUploaderProps {
  label: string;
  description: string;
  onFileSelect: (file: File) => void;
  selectedFile: File | null;
  icon: React.ReactNode;
}

const FileUploader: React.FC<FileUploaderProps> = ({ label, description, onFileSelect, selectedFile, icon }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileSelect(e.target.files[0]);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-slate-300 rounded-xl bg-white hover:border-blue-500 transition-colors cursor-pointer group relative">
      <input
        type="file"
        onChange={handleChange}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        accept="application/pdf,image/*,.docx"
      />
      <div className="text-blue-500 mb-4 group-hover:scale-110 transition-transform">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-slate-800">{label}</h3>
      <p className="text-sm text-slate-500 text-center mt-1">{description}</p>
      {selectedFile && (
        <div className="mt-4 px-4 py-2 bg-blue-50 text-blue-700 rounded-full text-xs font-medium border border-blue-100">
          Selected: {selectedFile.name}
        </div>
      )}
    </div>
  );
};

export default FileUploader;
