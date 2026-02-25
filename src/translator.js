import path from 'path';

import { GoogleGenerativeAI } from '@google/generative-ai';
import chalk from 'chalk';
import fs from 'fs-extra';
import { glob } from 'glob';

class MarkdownTranslator {
    /**
     * Default chunk size for splitting markdown content.
     * This is a starting point and can be adjusted based
     * on testing and typical file sizes.
     */
    static DEFAULT_CHUNK_SIZE = 50000;

    static MIN_CHUNK_SIZE = 6250;

    static CHUNK_RETRY_LIMIT = 3;

    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('Google Gemini API key is required');
        }
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.modelName = 'gemini-2.5-flash';
        this.model = this.genAI.getGenerativeModel({
            model: this.modelName,
            generationConfig: {
                temperature: 0  // Deterministic output for consistent translations
            }
        });
        console.log(chalk.gray(`Using model: ${this.modelName} (temperature: 0)`));
        // Load system prompt template and language dictionaries (if available)
        try {
            const configsDir = path.join(process.cwd(), 'src', 'configs');
            const systemPromptPath = path.join(configsDir, 'system_prompt.txt');
            if (fs.existsSync(systemPromptPath)) {
                this.systemPromptTemplate = fs.readFileSync(systemPromptPath, 'utf8');
            }

            const dictDir = path.join(configsDir, 'language_dicts');
            this.languageDictionaries = {};
            if (fs.existsSync(dictDir)) {
                const files = fs.readdirSync(dictDir);
                for (const f of files) {
                    const full = path.join(dictDir, f);
                    if (fs.statSync(full).isFile() && (f.endsWith('.yml') || f.endsWith('.yaml'))) {
                        const key = f.replace(/\.ya?ml$/i, '').toLowerCase();
                        this.languageDictionaries[key] = fs.readFileSync(full, 'utf8');
                    }
                }
            }
            // Load never-translate list if present
            const neverPath = path.join(configsDir, 'never_translate.yaml');
            if (fs.existsSync(neverPath)) {
                this.neverTranslate = fs.readFileSync(neverPath, 'utf8');
            } else {
                const neverPathYml = path.join(configsDir, 'never_translate.yml');
                if (fs.existsSync(neverPathYml)) {
                    this.neverTranslate = fs.readFileSync(neverPathYml, 'utf8');
                }
            }
        } catch (e) {
            // Non-fatal; continue without dictionaries
            this.systemPromptTemplate = this.systemPromptTemplate || null;
            this.languageDictionaries = this.languageDictionaries || {};
        }
    }

    /**
     * Split markdown content into chunks to handle large files.
     *
     * @param {string} content - The markdown content
     * @param {number} maxChunkSize - Maximum size per chunk
     * @returns {Array} Array of content chunks
     */
    splitIntoChunks(content, maxChunkSize = MarkdownTranslator.DEFAULT_CHUNK_SIZE) {
        // For most markdown files, this will result in a single chunk
        const lines = content.split('\n');
        const chunks = [];
        let currentChunk = '';

        for (const line of lines) {
            if (currentChunk.length + line.length + 1 > maxChunkSize && currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = line;
            } else {
                currentChunk += (currentChunk ? '\n' : '') + line;
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
        }

        return chunks;
    }

    /**
     * Build the next chunk from line array starting at a given index.
     *
     * @param {Array} lines - Markdown lines
     * @param {number} startIndex - Starting line index
     * @param {number} maxChunkSize - Maximum size per chunk
     * @returns {object} Chunk and next index
     */
    buildNextChunk(lines, startIndex, maxChunkSize) {
        let currentChunk = '';
        let index = startIndex;

        while (index < lines.length) {
            const line = lines[index];
            const nextLen = currentChunk.length + line.length + (currentChunk ? 1 : 0);
            if (nextLen > maxChunkSize && currentChunk.length > 0) {
                break;
            }

            if (nextLen > maxChunkSize && currentChunk.length === 0) {
                currentChunk = line;
                index += 1;
                break;
            }

            currentChunk += (currentChunk ? '\n' : '') + line;
            index += 1;
        }

        return {
            chunk: currentChunk.trim(),
            nextIndex: index
        };
    }

    /**
     * Count chunks from line array starting at a given index.
     *
     * @param {Array} lines - Markdown lines
     * @param {number} startIndex - Starting line index
     * @param {number} maxChunkSize - Maximum size per chunk
     * @returns {number} Estimated chunk count
     */
    countChunksFromLines(lines, startIndex, maxChunkSize) {
        let count = 0;
        let index = startIndex;

        while (index < lines.length) {
            const { nextIndex } = this.buildNextChunk(lines, index, maxChunkSize);
            if (nextIndex === index) {
                break;
            }
            count += 1;
            index = nextIndex;
        }

        return count;
    }

    /**
     * Create translation prompt for Gemini.
     *
     * @param {string} text - Text to translate
     * @param {string} targetLanguage - Target language
     * @param {string} sourceLanguage - Source language
     * @returns {string} Translation prompt
     */
    createTranslationPrompt(text, targetLanguage, sourceLanguage = 'English') {
        // Try to use system prompt template if available
        const tryGetDict = (lang) => {
            if (!lang) return '';
            const normalized = lang.toString().toLowerCase();
            if (this.languageDictionaries[normalized]) return this.languageDictionaries[normalized];
            // common aliases
            if (normalized.includes('chinese') || normalized.includes('zh')) {
                return this.languageDictionaries.zh || '';
            }
            if (normalized.includes('japan') || normalized.includes('japanese') || normalized === 'ja') {
                return this.languageDictionaries.ja || '';
            }
            if (normalized.includes('english') || normalized === 'en') {
                return this.languageDictionaries.en || '';
            }
            return '';
        };

        const dictionaryContent = tryGetDict(targetLanguage) || '';
        const neverTranslate = this.neverTranslate || '';

        if (this.systemPromptTemplate) {
            let prompt = this.systemPromptTemplate;
            prompt = prompt.replace(/\$\{source_lang\}/g, sourceLanguage);
            prompt = prompt.replace(/\$\{target_lang\}/g, targetLanguage);
            prompt = prompt.replace(/\$\{dictionary\}/g, dictionaryContent);
            prompt = prompt.replace(/\$\{never_translate\}/g, neverTranslate);
            prompt += `\n\nMarkdown content to translate:\n\n${text}`;
            return prompt;
        }

        // Fallback simple prompt if template missing
        return `Translate the following markdown content from ${sourceLanguage} to ${targetLanguage}.\n\nDICTIONARY:\n${dictionaryContent}\n\nNEVER TRANSLATE:\n${neverTranslate}\n\nIMPORTANT INSTRUCTIONS:\n1. Preserve ALL markdown formatting (headers, links, code blocks, tables, etc.)\n2. Do NOT translate code blocks themselves, URLs, or file paths\n3. DO translate code comments within code blocks (// comments, /* comments */, # comments, etc.)\n4. Do NOT translate markdown syntax characters\n5. Maintain the exact structure and formatting\n6. Only translate the actual text content, not the markup or code\n7. If there are any technical terms or proper nouns that shouldn't be translated, keep them in English\n8. Return ONLY the translated markdown, no explanations or additional text\n\nMarkdown content to translate:\n\n${text}`;
    }

    /**
     * Translate a single chunk of text.
     *
     * @param {string} chunk - Text chunk to translate
     * @param {string} targetLanguage - Target language
     * @param {string} sourceLanguage - Source language
     * @returns {Promise<string>} Translated text
     */
    async translateChunk(chunk, targetLanguage, sourceLanguage = 'English') {
        try {
            const prompt = this.createTranslationPrompt(chunk, targetLanguage, sourceLanguage);
            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            return {
                text: response.text().trim(),
                metadata: this.extractChunkMetadata(response)
            };
        } catch (error) {
            console.error(chalk.red(`Error translating chunk: ${error.message}`));
            throw error;
        }
    }

    /**
     * Translate markdown content.
     *
     * @param {string} content - Markdown content to translate
     * @param {string} targetLanguage - Target language
     * @param {string} sourceLanguage - Source language
     * @param {Function} progressCallback - Optional progress callback
     * @param {boolean} logChunkMetadata - Whether to log API metadata for each chunk
     * @returns {Promise<string>} Translated content
     */
    async translateMarkdown(
        content,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false
    ) {
        const lines = content.split('\n');
        let currentChunkSize = MarkdownTranslator.DEFAULT_CHUNK_SIZE;
        const minChunkSize = MarkdownTranslator.MIN_CHUNK_SIZE;
        const translatedChunks = [];

        let index = 0;
        let chunkIndex = 0;
        let estimatedTotal = this.countChunksFromLines(lines, index, currentChunkSize);

        console.log(chalk.blue(`Translating ${estimatedTotal} chunk(s) from ${sourceLanguage} to ${targetLanguage}...`));

        while (index < lines.length) {
            if (progressCallback) {
                progressCallback(chunkIndex + 1, estimatedTotal);
            }

            let attempt = 0;
            let translated = null;
            let chunk = '';
            let nextIndex = index;

            while (true) {
                const built = this.buildNextChunk(lines, index, currentChunkSize);
                chunk = built.chunk;
                nextIndex = built.nextIndex;

                if (!chunk) {
                    break;
                }

                // eslint-disable-next-line no-await-in-loop
                translated = await this.translateChunk(chunk, targetLanguage, sourceLanguage);

                // Always check completeness for this chunk
                const mismatches = this.getCompletenessMismatches(chunk, translated.text);

                // Always log chunk metadata and comparison results
                this.logChunkMetadata(chunkIndex + 1, estimatedTotal, translated.metadata, mismatches);

                const finishReason = translated.metadata?.finishReason || '';
                const hasMismatches = mismatches.length > 0;
                const shouldRetry =
                    (finishReason === 'MAX_TOKENS' || hasMismatches) &&
                    currentChunkSize > minChunkSize &&
                    attempt < MarkdownTranslator.CHUNK_RETRY_LIMIT;

                if (!shouldRetry) {
                    // Log failure but continue (allow tech writer to hand-edit)
                    if (hasMismatches) {
                        console.warn(chalk.yellow(`⚠️  Chunk ${chunkIndex + 1} has unresolved mismatches: ${mismatches.join('; ')} - continuing with next chunk`));
                    }
                    break;
                }

                const nextSize = Math.max(minChunkSize, Math.floor(currentChunkSize / 2));
                if (nextSize === currentChunkSize) {
                    break;
                }

                attempt += 1;
                currentChunkSize = nextSize;
                estimatedTotal = chunkIndex + this.countChunksFromLines(lines, index, currentChunkSize);
                console.warn(chalk.yellow(`Retrying chunk ${chunkIndex + 1} with smaller size: ${currentChunkSize}`));
            }

            if (!chunk) {
                if (nextIndex > index) {
                    index = nextIndex;
                    continue;
                }
                break;
            }

            translatedChunks.push(translated.text);
            index = nextIndex;
            chunkIndex += 1;

            // Add a small delay to avoid rate limiting
            if (index < lines.length) {
                // eslint-disable-next-line no-await-in-loop,no-promise-executor-return
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        const translatedContent = translatedChunks.join('\n\n');
        const finalContent = translatedContent.endsWith('\n') ? translatedContent : `${translatedContent}\n`;

        // Final check of entire file and always log result
        const finalMismatches = this.getCompletenessMismatches(content, finalContent);
        console.log(chalk.gray(`[final check] Entire file completeness: ${finalMismatches.length === 0 ? '✅ PASS' : '❌ FAIL'} ${finalMismatches.length > 0 ? `(${finalMismatches.join('; ')})` : ''}`));

        if (finalMismatches.length > 0) {
            throw new Error(`Final translation completeness check failed: ${finalMismatches.join('; ')}`);
        }

        return finalContent;
    }

    /**
     * Count headings (H1-H6) and fenced code blocks in markdown content.
     *
     * @param {string} content - Markdown content
     * @returns {object} Counts for headings and code blocks
     */
    getMarkdownStats(content) {
        const lines = content.split('\n');
        let inCodeBlock = false;
        let fenceChar = null;
        let fenceLen = 0;
        let headings = 0;
        let codeBlocks = 0;

        for (const line of lines) {
            const fenceMatch = line.match(/^\s*([`~]{3,})/);
            if (fenceMatch) {
                const currentFence = fenceMatch[1];
                const currentChar = currentFence[0];
                const currentLen = currentFence.length;

                if (!inCodeBlock) {
                    inCodeBlock = true;
                    fenceChar = currentChar;
                    fenceLen = currentLen;
                    codeBlocks += 1;
                } else if (currentChar === fenceChar && currentLen >= fenceLen) {
                    inCodeBlock = false;
                    fenceChar = null;
                    fenceLen = 0;
                }

                continue;
            }

            if (!inCodeBlock) {
                if (/^\s{0,3}#{1,6}\s+\S/.test(line)) {
                    headings += 1;
                }
            }
        }

        return { headings, codeBlocks };
    }

    /**
     * Ensure translated content preserves markdown structure.
     *
     * @param {string} originalContent - Original markdown content
     * @param {string} translatedContent - Translated markdown content
     * @returns {string[]} Array of mismatch descriptions (empty if no mismatches)
     */
    getCompletenessMismatches(originalContent, translatedContent) {
        const originalStats = this.getMarkdownStats(originalContent);
        const translatedStats = this.getMarkdownStats(translatedContent);

        const mismatches = [];
        if (originalStats.headings !== translatedStats.headings) {
            mismatches.push(`headings (expected ${originalStats.headings}, got ${translatedStats.headings})`);
        }
        if (originalStats.codeBlocks !== translatedStats.codeBlocks) {
            mismatches.push(`code blocks (expected ${originalStats.codeBlocks}, got ${translatedStats.codeBlocks})`);
        }

        return mismatches;
    }

    /**
     * Extract useful metadata from a chunk response.
     *
     * @param {object} response - Gemini response object
     * @returns {object} Normalized metadata
     */
    extractChunkMetadata(response) {
        const candidate = response?.candidates?.[0];
        return {
            finishReason: candidate?.finishReason || null,
            safetyRatings: candidate?.safetyRatings || null,
            promptFeedback: response?.promptFeedback || null,
            usageMetadata: response?.usageMetadata || null,
            candidates: response?.candidates?.length ?? null
        };
    }

    /**
     * Log chunk metadata to help diagnose truncation or safety stops.
     *
     * @param {number} index - 1-based chunk index
     * @param {number} total - Total chunks
     * @param {object} metadata - Metadata from extractChunkMetadata
     * @param {Array} mismatches - Completeness mismatches
     * @returns {void}
     */
    logChunkMetadata(index, total, metadata, mismatches = []) {
        const mismatchText = mismatches.length > 0 ? `; mismatches: ${mismatches.join('; ')}` : '';
        const summary = {
            finishReason: metadata?.finishReason || undefined,
            usageMetadata: metadata?.usageMetadata || undefined,
            promptFeedback: metadata?.promptFeedback || undefined,
            safetyRatings: metadata?.safetyRatings || undefined,
            candidates: metadata?.candidates || undefined
        };

        console.log(chalk.gray(`[chunk ${index}/${total}] metadata${mismatchText}: ${JSON.stringify(summary)}`));
    }

    /**
     * Translate a markdown file.
     *
     * @param {string} inputPath - Path to input markdown file
     * @param {string} outputPath - Path to output file
     * @param {string} targetLanguage - Target language
     * @param {string} sourceLanguage - Source language (default: English)
     * @param {Function} progressCallback - Optional progress callback
     * @param {boolean} logChunkMetadata - Whether to log API metadata for each chunk (default: false)
     * @returns {Promise<object>} Translation result
     */
    async translateFile(
        inputPath,
        outputPath,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false
    ) {
        let translatedContent = null;

        try {
            // Check if input file exists
            if (!await fs.pathExists(inputPath)) {
                throw new Error(`Input file does not exist: ${inputPath}`);
            }

            // Read the markdown file
            console.log(chalk.blue(`Reading file: ${inputPath}`));
            const content = await fs.readFile(inputPath, 'utf8');

            if (!content.trim()) {
                throw new Error('Input file is empty');
            }

            // Translate the content
            translatedContent = await this.translateMarkdown(
                content,
                targetLanguage,
                sourceLanguage,
                progressCallback,
                logChunkMetadata
            );

            // Ensure output directory exists
            const outputDir = path.dirname(outputPath);
            await fs.ensureDir(outputDir);

            // Write translated content
            await fs.writeFile(outputPath, translatedContent, 'utf8');
            console.log(chalk.green(`Translation completed: ${outputPath}`));

            return {
                inputPath,
                outputPath,
                sourceLanguage,
                targetLanguage,
                originalLength: content.length,
                translatedLength: translatedContent.length
            };
        } catch (error) {
            // If final check failed and we have translated content, write as .invalid
            if (translatedContent && error.message.includes('Final translation completeness check failed')) {
                const invalidPath = outputPath.endsWith('.md') || outputPath.endsWith('.markdown') || outputPath.endsWith('.mdx') ?
                    outputPath.replace(/\.(md|markdown|mdx)$/, '.invalid') :
                    `${outputPath}.invalid`;

                const outputDir = path.dirname(invalidPath);
                await fs.ensureDir(outputDir);
                await fs.writeFile(invalidPath, translatedContent, 'utf8');
                console.error(chalk.red(`❌ Translation failed - incomplete output written to: ${invalidPath}`));
            }

            console.error(chalk.red(`Error translating file: ${error.message}`));
            throw error;
        }
    }

    /**
     * Translate multiple markdown files using glob patterns.
     *
     * @param {string} inputPattern - Glob pattern for input files (e.g., "docs/\*\*\/\*.md")
     * @param {string} outputDir - Target directory for translated files
     * @param {string} targetLanguage - Target language
     * @param {Object} options - Translation options
     * @param {Function} options.progressCallback - Optional progress callback
     * @param {boolean} options.preserveStructure - Whether to preserve directory structure (default: true)
     * @param {string} options.suffix - Suffix to add to output files (default: empty)
     * @param {string} options.source - Source language (default: English)
     * @param {boolean} options.logChunkMetadata - Whether to log API metadata for each chunk (default: false)
     * @returns {Promise<Array>} Array of translation results
     */
    async translateFiles(inputPattern, outputDir, targetLanguage, options = {}) {
        const {
            progressCallback,
            preserveStructure = true,
            suffix = '',
            source = 'English',
            logChunkMetadata = false
        } = options;

        try {
            // Normalize Windows paths for glob matching
            const normalizedPattern = inputPattern.replace(/\\/g, '/');

            // Find all matching files
            console.log(chalk.blue(`Finding files matching pattern: ${inputPattern}`));
            const files = await glob(normalizedPattern, {
                ignore: ['node_modules/**', '.git/**', '**/.*'],
                windowsPathsNoEscape: true
            });

            if (files.length === 0) {
                throw new Error(`No files found matching pattern: ${inputPattern}`);
            }

            // Filter for markdown files only
            const markdownFiles = files.filter((file) => {
                const ext = path.extname(file).toLowerCase();
                return ext === '.md' || ext === '.markdown' || ext === '.mdx';
            });

            if (markdownFiles.length === 0) {
                throw new Error('No markdown files found in the matched files');
            }

            console.log(chalk.green(`Found ${markdownFiles.length} markdown file(s) to translate`));

            // Ensure output directory exists
            await fs.ensureDir(outputDir);

            const results = [];
            let processedFiles = 0;

            for (const inputFile of markdownFiles) {
                try {
                    // Calculate output path
                    let outputPath;
                    if (preserveStructure) {
                        // Preserve relative directory structure
                        const normalizedInputFile = inputFile.replace(/\\/g, '/');
                        const normalizedInputPattern = inputPattern.replace(/\\/g, '/');

                        // Extract the base directory from the pattern
                        let baseDir = '';
                        if (path.isAbsolute(normalizedInputPattern)) {
                            // For absolute patterns like "C:/path/to/docs/**/*.md"
                            const patternParts = normalizedInputPattern.split('/');
                            const wildcardIndex = patternParts.findIndex(part => part.includes('*'));
                            if (wildcardIndex > 0) {
                                baseDir = patternParts.slice(0, wildcardIndex).join('/');
                            }
                        }

                        let relativePath;
                        if (baseDir && normalizedInputFile.startsWith(baseDir)) {
                            relativePath = path.relative(baseDir, normalizedInputFile);
                        } else {
                            relativePath = path.relative(process.cwd(), normalizedInputFile);
                        }

                        const parsed = path.parse(relativePath);
                        const newName = suffix ? `${parsed.name}_${suffix}${parsed.ext}` : `${parsed.name}${parsed.ext}`;
                        outputPath = path.join(outputDir, parsed.dir, newName);
                    } else {
                        // Flat structure in output directory
                        const parsed = path.parse(inputFile);
                        const newName = suffix ? `${parsed.name}_${suffix}${parsed.ext}` : `${parsed.name}${parsed.ext}`;
                        outputPath = path.join(outputDir, newName);
                    }

                    console.log(chalk.yellow(`\n[${processedFiles + 1}/${markdownFiles.length}] Translating: ${inputFile}`));

                    // Create per-file progress callback
                    const currentFileIndex = processedFiles + 1;
                    const fileProgressCallback = progressCallback ?
                        (chunk, total) => progressCallback(currentFileIndex, markdownFiles.length, chunk, total, inputFile) :
                        undefined;

                    // Translate the file
                    // eslint-disable-next-line no-await-in-loop
                    const result = await this.translateFile(
                        inputFile,
                        outputPath,
                        targetLanguage,
                        source,
                        fileProgressCallback,
                        logChunkMetadata
                    );
                    results.push(result);

                    processedFiles++;
                    console.log(chalk.green(`✅ Completed: ${outputPath}`));

                } catch (error) {
                    console.error(chalk.red(`❌ Failed to translate ${inputFile}: ${error.message}`));
                    results.push({
                        inputPath: inputFile,
                        error: error.message,
                        success: false
                    });
                }
            }

            // Summary
            const successful = results.filter(r => !r.error).length;
            const failed = results.length - successful;

            console.log(chalk.blue('\n📊 Batch Translation Summary:'));
            console.log(chalk.green(`   ✅ Successful: ${successful}`));
            if (failed > 0) {
                console.log(chalk.red(`   ❌ Failed: ${failed}`));
            }
            console.log(chalk.gray(`   📁 Output directory: ${outputDir}`));

            return results;

        } catch (error) {
            console.error(chalk.red(`Error in batch translation: ${error.message}`));
            throw error;
        }
    }

    /**
     * Get supported languages (common ones).
     *
     * @returns {Array} Array of supported language names
     */
    static getSupportedLanguages() {
        return [
            'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch',
            'Russian', 'Chinese', 'Japanese', 'Korean', 'Arabic', 'Hindi',
            'Turkish', 'Polish', 'Swedish', 'Norwegian', 'Danish', 'Finnish',
            'Greek', 'Hebrew', 'Thai', 'Vietnamese', 'Indonesian', 'Malay',
            'Ukrainian', 'Czech', 'Hungarian', 'Romanian', 'Bulgarian',
            'Croatian', 'Serbian', 'Slovak', 'Slovenian', 'Estonian',
            'Latvian', 'Lithuanian', 'Catalan', 'Basque', 'Welsh', 'Irish'
        ];
    }
}

export default MarkdownTranslator;
