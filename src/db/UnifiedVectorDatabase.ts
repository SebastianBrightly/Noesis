import { LoggingUtility } from '../utils/LoggingUtility';
import { App } from 'obsidian';
import initSqlJs from '@webreflection/sql.js';
// @ts-ignore
import sqlWasm from 'sql.js/dist/sql-wasm.wasm';
import { MigrationRunner } from './MigrationRunner';
import type { SqliteDatabase, SqliteModule } from './SqliteTypes';

type InitSqlJs = (config: { wasmBinary: unknown }) => Promise<SqliteModule>;

export interface VectorDocument {
	id: string; // unique id for the paragraph (e.g., "file.md#p1" or "image.png#c1")
	vector: number[]; // embedding vector
	metadata: {
		filePath: string;
		fileName?: string; // optional, mainly for images
		title: string;
		paragraphIndex: number;
		sectionIndex?: number;
		paragraphText: string; // store the actual paragraph text for retrieval
		anchorType?: 'block' | 'heading' | 'chunk';
		anchorValue?: string;
		anchorTarget?: string;
		headingPath?: string;
		headingSlug?: string;
		fileChecksum: string; // checksum of entire file
		lastModified?: number; // optional, mainly for images
		fileSize?: number; // optional, mainly for images
		sourceType: 'markdown' | 'image'; // type of source file
		extractedText?: boolean; // whether text was extracted from image
	};
}

export interface VectorSearchResult {
	activeDocument: VectorDocument;
	similarity: number;
}

export class UnifiedVectorDatabase {
	private db: SqliteDatabase | null = null;
	private dbPath: string;
	private app: App;
	private dimension: number = 0;
	private savePromise: Promise<void> | null = null;
	private saveQueued: boolean = false;

	private readonly CURRENT_SCHEMA_VERSION = 1;

	constructor(app: App, dbPath: string) {
		this.app = app;
		this.dbPath = dbPath;
	}

	private toNumber(value: unknown): number | null {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}

		if (typeof value === 'string' && value.trim().length > 0) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}

		return null;
	}

	private toString(value: unknown): string | null {
		if (typeof value === 'string') {
			return value;
		}

		return null;
	}

	private parseVector(value: unknown): number[] {
		const vectorJson = this.toString(value);
		if (!vectorJson) {
			return [];
		}

		try {
			const parsed: unknown = JSON.parse(vectorJson);
			if (!Array.isArray(parsed)) {
				return [];
			}

			const numbers = parsed
				.map((item) => this.toNumber(item))
				.filter((item): item is number => item !== null);

			return numbers;
		} catch {
			return [];
		}
	}

	private mapRowToDocument(row: Record<string, unknown>): VectorDocument | null {
		const id = this.toString(row.id);
		const filePath = this.toString(row.file_path);
		const title = this.toString(row.title);
		const paragraphText = this.toString(row.paragraph_text);
		const fileChecksum = this.toString(row.file_checksum);
		const paragraphIndex = this.toNumber(row.paragraph_index);

		if (!id || !filePath || !title || !paragraphText || !fileChecksum || paragraphIndex === null) {
			return null;
		}

		const sourceType = row.source_type === 'image' ? 'image' : 'markdown';

		return {
			id,
			vector: this.parseVector(row.vector_json),
			metadata: {
				filePath,
				fileName: this.toString(row.file_name) ?? undefined,
				title,
				paragraphIndex,
				sectionIndex: this.toNumber(row.section_index) ?? undefined,
				paragraphText,
				anchorType: (this.toString(row.anchor_type) as 'block' | 'heading' | 'chunk' | null) ?? undefined,
				anchorValue: this.toString(row.anchor_value) ?? undefined,
				anchorTarget: this.toString(row.anchor_target) ?? undefined,
				headingPath: this.toString(row.heading_path) ?? undefined,
				headingSlug: this.toString(row.heading_slug) ?? undefined,
				fileChecksum,
				lastModified: this.toNumber(row.last_modified) ?? undefined,
				fileSize: this.toNumber(row.file_size) ?? undefined,
				sourceType,
				extractedText: this.toNumber(row.extracted_text) === 1
			}
		};
	}

	private sanitizeVaultPath(pathValue: string): string {
		return pathValue.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
	}

	private getParentPath(pathValue: string): string {
		const normalized = this.sanitizeVaultPath(pathValue);
		const lastSlash = normalized.lastIndexOf('/');
		return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const normalized = this.sanitizeVaultPath(folderPath);
		if (!normalized) {
			return;
		}

		if (await this.app.vault.adapter.exists(normalized)) {
			return;
		}

		const segments = normalized.split('/').filter(segment => segment.length > 0);
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.adapter.mkdir(current);
			}
		}
	}

	/**
	 * Initialize the database connection and create tables if needed
	 */
	async load(): Promise<void> {
		try {
			// Ensure the directory exists
			const dbDir = this.getParentPath(this.dbPath);
			if (!(await this.app.vault.adapter.exists(dbDir))) {
				await this.ensureFolder(dbDir);
				LoggingUtility.log(`Created database directory: ${dbDir}`);
			}

			// Open database connection
			// Load WASM file from imported binary (inlined by esbuild)
			const initSqlJsTyped = initSqlJs as unknown as InitSqlJs;
			const SQL = await initSqlJsTyped({
				wasmBinary: sqlWasm
			});

			// Load database if it exists, otherwise create new
			let dbFile;
			if (await this.app.vault.adapter.exists(this.dbPath)) {
				const buffer = await this.app.vault.adapter.readBinary(this.dbPath);
				dbFile = new Uint8Array(buffer);
			}
			this.db = new SQL.Database(dbFile);

			// Enable WAL mode for better concurrency - sql.js might not support this as it's in-memory/file-backed, but we can try
			// Note: sql.js is usually synchronous and in-memory, requiring explicit save.
			// The original code assumed standard SQLite. usage of WAL with sql.js (file-backed emulation) might be no-op.
			try {
				this.db.run("PRAGMA journal_mode = WAL");
			} catch (e) {
				LoggingUtility.error("Could not set WAL mode (might be unsupported in this WASM build):", e);
			}

			// Initialize schema version table
			this.db.run(`
				CREATE TABLE IF NOT EXISTS schema_versions (
					version INTEGER PRIMARY KEY,
					migrated_at INTEGER NOT NULL
				);
			`);

			// Initialize metadata table for persistent key/value storage (e.g. vector dimension)
			this.db.run(`
				CREATE TABLE IF NOT EXISTS metadata (
					key TEXT PRIMARY KEY,
					value TEXT
				);
			`);

			// Check current version
			let currentVersion = 0;
			try {
				const stmt = this.db.prepare('SELECT MAX(version) as v FROM schema_versions');
				if (stmt.step()) {
					const row = stmt.getAsObject();
					const version = this.toNumber(row.v);
					if (version !== null) {
						currentVersion = version;
					}
				}
				stmt.free();
			} catch (e) {
				LoggingUtility.error('Error checking schema version:', e);
			}

			LoggingUtility.log(`Current database schema version: ${currentVersion}`);

			// Check for legacy database (has documents table but no schema version)
			if (currentVersion === 0) {
				const tableCheck = this.db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='documents'");
				if (tableCheck.step()) {
					const count = this.toNumber(tableCheck.getAsObject().count) ?? 0;
					if (count > 0) {
						currentVersion = 1;
						// Mark as version 1
						this.db.run('INSERT INTO schema_versions (version, migrated_at) VALUES (?, ?)', [1, Date.now()]);
						LoggingUtility.log('Detected legacy database, validated as schema version 1');
					}
				}
				tableCheck.free();
			}

			// Run migrations
			try {
				const runner = new MigrationRunner();
				await runner.run(this.db, currentVersion);

				// Save immediately if any migrations ran
				// We can't easily know if migrations ran without checking version again or having runner return boolean
				// But saving is cheap enough here
				await this.save();

				// After migrations, try to load persisted vector dimension from metadata
				try {
					const dimStmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
					dimStmt.bind(['dimension']);
					if (dimStmt.step()) {
						const row = dimStmt.getAsObject();
						const parsed = this.toNumber(row.value);
						if (parsed !== null && parsed > 0) {
							this.dimension = parsed;
							LoggingUtility.log(`Loaded persisted vector dimension: ${this.dimension}`);
						}
					}
					dimStmt.free();
				} catch (err) {
					LoggingUtility.warn('Could not read persisted vector dimension from metadata:', err);
				}

				// If no persisted dimension but documents exist, infer dimension from first document row and persist it
				if (this.dimension === 0) {
					try {
						const docDimStmt = this.db.prepare('SELECT dimension FROM documents LIMIT 1');
						if (docDimStmt.step()) {
							const row = docDimStmt.getAsObject();
							const parsed = this.toNumber(row.dimension);
							if (parsed !== null && parsed > 0) {
								this.dimension = parsed;
								LoggingUtility.log(`Inferred vector dimension from existing documents: ${this.dimension}`);
								// Persist for future loads
								this.db.run('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', ['dimension', String(this.dimension)]);
							}
						}
						docDimStmt.free();
					} catch (err) {
						LoggingUtility.warn('Could not infer vector dimension from documents:', err);
					}
				}
			} catch (error) {
				LoggingUtility.error('Migration failed:', error);
				throw error;
			}
		} catch (error) {
			LoggingUtility.error('Failed to load unified vector database:', error);
			throw error;
		}
	}

	/**
	 * Close the database connection
	 */
	async close(): Promise<void> {
		if (this.db) {
			this.db.close();
			this.db = null;
			LoggingUtility.log('Closed unified vector database');
		}
	}

	isLoaded(): boolean {
		return this.db !== null;
	}

	clearDocumentsBySourceType(sourceType: 'markdown' | 'image'): void {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		this.db.run('DELETE FROM documents WHERE source_type = ?', [sourceType]);
	}

	private executeCountQuery(sql: string, params: unknown[] = []): number {
		if (!this.db) {
			return 0;
		}

		const stmt = this.db.prepare(sql);
		if (params.length > 0) {
			stmt.bind(params);
		}

		let count = 0;
		if (stmt.step()) {
			count = this.toNumber(stmt.getAsObject().count) ?? 0;
		}
		stmt.free();

		return count;
	}

	getSourceBreakdown(): {
		markdownDocuments: number;
		imageDocuments: number;
		markdownFiles: number;
		imageFiles: number;
	} {
		if (!this.db) {
			return {
				markdownDocuments: 0,
				imageDocuments: 0,
				markdownFiles: 0,
				imageFiles: 0
			};
		}

		return {
			markdownDocuments: this.executeCountQuery('SELECT COUNT(*) as count FROM documents WHERE source_type = ?', ['markdown']),
			imageDocuments: this.executeCountQuery('SELECT COUNT(*) as count FROM documents WHERE source_type = ?', ['image']),
			markdownFiles: this.executeCountQuery('SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE source_type = ?', ['markdown']),
			imageFiles: this.executeCountQuery('SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE source_type = ?', ['image'])
		};
	}

	/**
	 * Add or update documents for a file
	 */
	async upsertFileDocuments(filePath: string, documents: VectorDocument[]): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		if (documents.length === 0) {
			return;
		}

		// Set dimension from first document if not set
		if (this.dimension === 0 && documents[0].vector.length > 0) {
			this.dimension = documents[0].vector.length;
			LoggingUtility.log(`Set vector dimension to ${this.dimension}`);
		}

		// Validate dimension for all documents
		for (const doc of documents) {
			if (doc.vector.length !== this.dimension) {
				throw new Error(`Vector dimension mismatch. Expected ${this.dimension}, got ${doc.vector.length}`);
			}
		}

		// Start transaction
		this.db.run("BEGIN TRANSACTION");
		try {
			// Remove existing documents for this file
			this.db.run('DELETE FROM documents WHERE file_path = ?', [filePath]);

			// Insert new documents
			const insertStmt = this.db.prepare(`
				INSERT INTO documents (
					id, file_path, file_name, title, paragraph_index, section_index, paragraph_text,
					anchor_type, anchor_value, anchor_target, heading_path, heading_slug,
					file_checksum, last_modified, file_size, source_type, extracted_text,
					vector_json, dimension, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
			`);

			for (const doc of documents) {
				insertStmt.run([
					doc.id,
					doc.metadata.filePath,
					doc.metadata.fileName || null,
					doc.metadata.title,
					doc.metadata.paragraphIndex,
					doc.metadata.sectionIndex ?? null,
					doc.metadata.paragraphText,
					doc.metadata.anchorType ?? null,
					doc.metadata.anchorValue ?? null,
					doc.metadata.anchorTarget ?? null,
					doc.metadata.headingPath ?? null,
					doc.metadata.headingSlug ?? null,
					doc.metadata.fileChecksum,
					doc.metadata.lastModified || null,
					doc.metadata.fileSize || null,
					doc.metadata.sourceType,
					doc.metadata.extractedText ? 1 : 0,
					JSON.stringify(doc.vector),
					this.dimension
				]);
			}
			insertStmt.free();

			this.db.run("COMMIT");
			LoggingUtility.log(`Updated ${documents.length} documents for file: ${filePath}`);

			// Persist to disk immediately since sql.js is in-memory
			await this.save();
		} catch (error) {
			this.db.run("ROLLBACK");
			LoggingUtility.error('Failed to upsert file documents:', error);
			throw error;
		}

			// Persist current dimension to metadata for future loads
			try {
				if (this.dimension > 0) {
					this.db.run('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', ['dimension', String(this.dimension)]);
					await this.save();
					LoggingUtility.log(`Persisted vector dimension: ${this.dimension}`);
				}
			} catch (err) {
				LoggingUtility.warn('Could not persist vector dimension to metadata:', err);
			}
	}

	/**
	 * Remove all documents for a specific file
	 */
	async removeFileDocuments(filePath: string): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		this.db.run('DELETE FROM documents WHERE file_path = ?', [filePath]);
		const changes = this.db.getRowsModified();

		// Persist to disk
		await this.save();

		if (changes > 0) {
			LoggingUtility.log(`Removed ${changes} documents for file: ${filePath}`);
		}
	}

	/**
	 * Search for similar documents using cosine similarity
	 */
	search(queryVector: number[], limit: number = 5, threshold: number = 0.5): VectorSearchResult[] {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		LoggingUtility.log(`Searching for ${limit} similar documents with threshold ${threshold}`);

		// Validate query vector dimension
		if (queryVector.length !== this.dimension) {
			throw new Error(`Query vector dimension mismatch. Expected ${this.dimension}, got ${queryVector.length}`);
		}

		// Get all documents
		const stmt = this.db.prepare('SELECT * FROM documents');
		const rows: Array<Record<string, unknown>> = [];
		while (stmt.step()) {
			rows.push(stmt.getAsObject());
		}
		stmt.free();

		if (rows.length === 0) {
			return [];
		}

		const startTime = Date.now();

		// Calculate similarities
		const similarities: VectorSearchResult[] = [];
		for (const row of rows) {
			const docVector = this.parseVector(row.vector_json);
			const activeDocument = this.mapRowToDocument(row);
			if (!activeDocument) {
				continue;
			}

			activeDocument.vector = docVector;
			const similarity = this.cosineSimilarity(queryVector, docVector);

			if (similarity >= threshold) {
				similarities.push({
					activeDocument,
					similarity
				});
			}
		}

		// Sort by similarity and limit results
		const results = similarities
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, limit);

		LoggingUtility.log(`Found ${results.length} similar documents in ${Date.now() - startTime}ms`);
		return results;
	}

	/**
	 * Search for similar documents and group by file
	 */
	searchGroupedByFile(queryVector: number[], maxFiles: number = 3, maxParagraphsPerFile: number = 3, threshold: number = 0.5): Map<string, VectorSearchResult[]> {
		const allResults = this.search(queryVector, maxFiles * maxParagraphsPerFile * 2, threshold);

		// Group by file
		const resultsByFile = new Map<string, VectorSearchResult[]>();

		for (const result of allResults) {
			const filePath = result.activeDocument.metadata.filePath;

			if (!resultsByFile.has(filePath)) {
				resultsByFile.set(filePath, []);
			}

			const fileResults = resultsByFile.get(filePath)!;
			if (fileResults.length < maxParagraphsPerFile) {
				fileResults.push(result);
			}
		}

		// Keep only top files by best paragraph similarity
		const sortedFiles = Array.from(resultsByFile.entries())
			.sort((a, b) => b[1][0].similarity - a[1][0].similarity)
			.slice(0, maxFiles);

		return new Map(sortedFiles);
	}

	/**
	 * Calculate cosine similarity between two vectors
	 */
	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) {
			throw new Error('Vectors must have the same dimension');
		}

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		normA = Math.sqrt(normA);
		normB = Math.sqrt(normB);

		if (normA === 0 || normB === 0) {
			return 0;
		}

		return dotProduct / (normA * normB);
	}

	/**
	 * Clear the entire database
	 */
	async clear(): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		this.db.run('DELETE FROM documents');
		// Persist changes
		await this.save();

		// Remove persisted dimension metadata as index is cleared
		try {
			this.db.run('DELETE FROM metadata WHERE key = ?', ['dimension']);
			await this.save();
		} catch (err) {
			LoggingUtility.warn('Could not remove persisted dimension metadata:', err);
		}

		this.dimension = 0;
		LoggingUtility.log('Cleared unified vector database');
	}

	/**
	 * Get statistics about the database
	 */
	getStats(): { documentCount: number; fileCount: number; lastUpdated: Date; sizeInBytes: number } {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM documents');
		countStmt.step();
		const countResult = countStmt.getAsObject();
		countStmt.free();

		const fileCountStmt = this.db.prepare('SELECT COUNT(DISTINCT file_path) as count FROM documents');
		fileCountStmt.step();
		const fileCountResult = fileCountStmt.getAsObject();
		fileCountStmt.free();

		const lastUpdatedStmt = this.db.prepare('SELECT MAX(updated_at) as last_updated FROM documents');
		lastUpdatedStmt.step();
		const lastUpdatedResult = lastUpdatedStmt.getAsObject();
		lastUpdatedStmt.free();

		// Get database file size
		let sizeInBytes = 0;
		try {
			sizeInBytes = this.db.export().byteLength;
		} catch (error) {
			LoggingUtility.warn('Could not get database file size:', error);
		}

		return {
			documentCount: this.toNumber(countResult.count) ?? 0,
			fileCount: this.toNumber(fileCountResult.count) ?? 0,
			lastUpdated: this.toNumber(lastUpdatedResult.last_updated) ? new Date((this.toNumber(lastUpdatedResult.last_updated) ?? 0) * 1000) : new Date(),
			sizeInBytes
		};
	}

	/**
	 * Check if a file exists in the database
	 */
	hasFile(filePath: string): boolean {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		const stmt = this.db.prepare('SELECT COUNT(*) as count FROM documents WHERE file_path = ?');
		stmt.bind([filePath]);
		stmt.step();
		const result = stmt.getAsObject();
		stmt.free();

		return (this.toNumber(result.count) ?? 0) > 0;
	}

	/**
	 * Get all documents for a specific file
	 */
	getFileDocuments(filePath: string): VectorDocument[] {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		const stmt = this.db.prepare('SELECT * FROM documents WHERE file_path = ? ORDER BY paragraph_index');
		stmt.bind([filePath]);
		const rows: Array<Record<string, unknown>> = [];
		while (stmt.step()) {
			rows.push(stmt.getAsObject());
		}
		stmt.free();

		const documents: VectorDocument[] = [];
		for (const row of rows) {
			const mappedDocument = this.mapRowToDocument(row);
			if (mappedDocument) {
				documents.push(mappedDocument);
			}
		}

		return documents;
	}

	/**
	 * Get all documents in the database
	 */
	getAllDocuments(): VectorDocument[] {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		const stmt = this.db.prepare('SELECT * FROM documents');
		const rows: Array<Record<string, unknown>> = [];
		while (stmt.step()) {
			rows.push(stmt.getAsObject());
		}
		stmt.free();

		const documents: VectorDocument[] = [];
		for (const row of rows) {
			const mappedDocument = this.mapRowToDocument(row);
			if (mappedDocument) {
				documents.push(mappedDocument);
			}
		}

		return documents;
	}

	/**
	 * Check if a file needs to be updated based on checksum
	 */
	fileNeedsUpdate(filePath: string, checksum: string, lastModified: number, size: number): boolean {
		const fileDocuments = this.getFileDocuments(filePath);

		if (fileDocuments.length === 0) {
			return true; // File doesn't exist in database
		}

		// Check if any of the key properties have changed
		const firstDoc = fileDocuments[0];
		return firstDoc.metadata.fileChecksum !== checksum;
	}

	/**
	 * Get files that need updating based on file stats
	 */
	getFilesNeedingUpdate(fileStats: Map<string, { checksum: string; lastModified: number; size: number }>): string[] {
		const needsUpdate: string[] = [];

		for (const [filePath, stats] of fileStats) {
			if (this.fileNeedsUpdate(filePath, stats.checksum, stats.lastModified, stats.size)) {
				needsUpdate.push(filePath);
			}
		}

		return needsUpdate;
	}

	/**
	 * Remove documents for files that no longer exist in the file system
	 */
	async removeObsoleteDocuments(existingFiles: Set<string>): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized. Call load() first.');
		}

		// Get all file paths from database
		const stmt = this.db.prepare('SELECT DISTINCT file_path FROM documents');
		const rows: Array<{ file_path: string }> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as { file_path?: unknown };
			if (typeof row.file_path === 'string') {
				rows.push({ file_path: row.file_path });
			}
		}
		stmt.free();

		const dbFilePaths = new Set(rows.map((row) => row.file_path));

		// Find files that exist in database but not in file system
		const filesToRemove: string[] = [];
		for (const dbFilePath of dbFilePaths) {
			if (!existingFiles.has(dbFilePath)) {
				filesToRemove.push(dbFilePath);
			}
		}

		// Remove documents for obsolete files
		if (filesToRemove.length > 0) {
			this.db.run("BEGIN TRANSACTION");
			try {
				const deleteStmt = this.db.prepare('DELETE FROM documents WHERE file_path = ?');
				for (const filePath of filesToRemove) {
					deleteStmt.run([filePath]);
				}
				deleteStmt.free();
				this.db.run("COMMIT");

				LoggingUtility.log(`Removed ${filesToRemove.length} obsolete file entries from database`);

				// Persist changes
				await this.save();
			} catch (error) {
				this.db.run("ROLLBACK");
				LoggingUtility.error('Failed to remove obsolete documents:', error);
			}
		}
	}

	/**
	 * Save the database to disk
	 */
	async save(): Promise<void> {
		if (!this.db) {
			return;
		}

		// Coalesce bursts of save() calls into at most one extra flush while a write is running.
		if (this.savePromise) {
			this.saveQueued = true;
			await this.savePromise;
			return;
		}

		this.savePromise = (async () => {
			do {
				this.saveQueued = false;
				const data = this.db!.export();
				const binaryCopy = new Uint8Array(data.byteLength);
				binaryCopy.set(data);
				await this.app.vault.adapter.writeBinary(this.dbPath, binaryCopy.buffer);
			} while (this.saveQueued);
		})();

		try {
			await this.savePromise;
		} finally {
			this.savePromise = null;
		}
	}
}
