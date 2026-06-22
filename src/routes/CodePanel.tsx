import { useState } from 'react';
import { Check, File, Loader, Pencil, X } from 'lucide-react';
import clsx from 'clsx';
import type { SessionFileEntry } from '@/api-types';
import { apiClient } from '@/lib/api-client';

interface CodePanelProps {
	sessionId: string;
	files: SessionFileEntry[];
	onSelectedFileChange?: (path: string | null) => void;
}

export function CodePanel({ sessionId, files, onSelectedFileChange }: CodePanelProps) {
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState<string | null>(null);
	const [loadingFile, setLoadingFile] = useState(false);
	const [editMode, setEditMode] = useState(false);
	const [editContent, setEditContent] = useState('');
	const [saving, setSaving] = useState(false);

	const handleFileClick = async (filePath: string) => {
		setSelectedFile(filePath);
		onSelectedFileChange?.(filePath);
		setFileContent(null);
		setEditMode(false);
		setLoadingFile(true);
		const result = await apiClient.getSessionFileContent(sessionId, filePath);
		setFileContent(result.data?.content ?? '// Error loading file');
		setLoadingFile(false);
	};

	const handleSaveFile = async () => {
		if (!selectedFile) return;
		setSaving(true);
		await apiClient.updateSessionFileContent(sessionId, selectedFile, editContent);
		setFileContent(editContent);
		setEditMode(false);
		setSaving(false);
	};

	return (
		<div className="flex-1 flex overflow-hidden min-h-0">
			<div className="w-48 flex-shrink-0 border-r border-border-primary/30 overflow-y-auto p-1 bg-bg-1">
				{files.length === 0 ? (
					<p className="text-xs text-text-tertiary italic p-3">No files yet…</p>
				) : (
					files.map(file => (
						<button
							key={file.path}
							type="button"
							onClick={() => void handleFileClick(file.path)}
							className={clsx(
								'w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-left transition-colors',
								selectedFile === file.path
									? 'bg-accent/10 text-accent'
									: 'text-text-secondary hover:bg-bg-3/50 hover:text-text-primary',
							)}
						>
							<File className="size-3 flex-shrink-0" />
							<span className="truncate">{file.path}</span>
						</button>
					))
				)}
			</div>
			<div className="flex-1 flex flex-col overflow-hidden bg-bg-1">
				{selectedFile && !loadingFile && fileContent !== null && (
					<div className="flex-shrink-0 flex items-center justify-end gap-1.5 px-3 py-1.5 border-b border-border-primary/20">
						{editMode ? (
							<>
								<button
									type="button"
									onClick={() => void handleSaveFile()}
									disabled={saving}
									className="flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
								>
									{saving ? <Loader className="size-3 animate-spin" /> : <Check className="size-3" />}
									{saving ? 'Saving…' : 'Save'}
								</button>
								<button
									type="button"
									onClick={() => setEditMode(false)}
									className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-3 transition-colors"
								>
									<X className="size-3" />
									Cancel
								</button>
							</>
						) : (
							<button
								type="button"
								onClick={() => { setEditContent(fileContent); setEditMode(true); }}
								className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-3 transition-colors"
							>
								<Pencil className="size-3" />
								Edit
							</button>
						)}
					</div>
				)}
				<div className="flex-1 overflow-auto">
					{!selectedFile ? (
						<p className="text-xs text-text-tertiary italic p-4">Select a file to view</p>
					) : loadingFile ? (
						<div className="flex items-center gap-2 p-4 text-text-tertiary">
							<Loader className="size-3 animate-spin" />
							<span className="text-xs">Loading…</span>
						</div>
					) : editMode ? (
						<textarea
							value={editContent}
							onChange={e => setEditContent(e.target.value)}
							className="w-full h-full p-4 text-xs font-mono text-text-primary bg-bg-1 resize-none outline-none leading-relaxed"
							spellCheck={false}
						/>
					) : (
						<pre className="p-4 text-xs font-mono text-text-primary whitespace-pre-wrap break-words leading-relaxed">
							{fileContent ?? ''}
						</pre>
					)}
				</div>
			</div>
		</div>
	);
}
