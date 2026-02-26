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

    static CHUNK_TARGET_MIN = 6;

    static CHUNK_TARGET_MAX = 14;

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
     * Build the next chunk from line array using a chunk strategy.
     *
     * @param {Array} lines - Markdown lines
     * @param {number} startIndex - Starting line index
     * @param {number} maxChunkSize - Maximum size per chunk
     * @param {string} chunkStrategy - one of: none, h2, h3, h4, h5, h6
     * @returns {object} Chunk and next index
     */
    buildNextChunkWithStrategy(lines, startIndex, maxChunkSize, chunkStrategy = 'h3') {
        if (chunkStrategy === 'none') {
            return this.buildNextChunk(lines, startIndex, maxChunkSize);
        }

        const levelMatch = chunkStrategy.match(/^h([2-6])$/i);
        if (!levelMatch) {
            return this.buildNextChunk(lines, startIndex, maxChunkSize);
        }

        const headingLevel = Number(levelMatch[1]);
        return this.buildNextChunkAtSectionBoundary(lines, startIndex, maxChunkSize, headingLevel);
    }

    /**
     * Build the next chunk from line array respecting section boundaries.
     * This prevents breaking mid-section which causes context loss and spurious list items.
     * Heading level is configurable (H2-H6) to balance chunk count vs contextual cohesion.
     *
     * @param {Array} lines - Markdown lines
     * @param {number} startIndex - Starting line index
     * @param {number} maxChunkSize - Maximum size per chunk
     * @param {number} headingLevel - Markdown heading level (2-6) for boundaries
     * @returns {object} Chunk and next index
     */
    buildNextChunkAtSectionBoundary(lines, startIndex, maxChunkSize, headingLevel = 3) {
        let currentChunk = '';
        let index = startIndex;
        const safeLevel = Math.min(6, Math.max(2, Number(headingLevel) || 3));
        const sectionHeaderRegex = new RegExp(`^\\s{0,3}#{${safeLevel}}(?!#)\\s+\\S`);

        while (index < lines.length) {
            const line = lines[index];
            const nextLen = currentChunk.length + line.length + (currentChunk ? 1 : 0);

            // If next line is a section boundary and current chunk has content, break
            if (
                sectionHeaderRegex.test(line) &&
                currentChunk.length > 0
            ) {
                break;
            }

            // If adding this line would exceed size limit and we already have content, break
            if (nextLen > maxChunkSize && currentChunk.length > 0) {
                break;
            }

            // If this single line is huge (oversized section), still need to add it to avoid infinite loop
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
     * Get next finer chunk strategy.
     *
     * @param {string} chunkStrategy - Current chunk strategy
     * @returns {string|null} Next finer strategy or null if already finest
     */
    getNextFinerChunkStrategy(chunkStrategy) {
        const order = ['none', 'h2', 'h3', 'h4', 'h5', 'h6'];
        const idx = order.indexOf(chunkStrategy);
        if (idx < 0 || idx >= order.length - 1) {
            return null;
        }
        return order[idx + 1];
    }

    /**
     * Compute a reduced chunk size after a failed attempt.
     * Uses the actual failed chunk length and retry stage to avoid over/under-shrinking.
     *
     * @param {number} currentChunkSize - Current chunk size cap
     * @param {number} failedChunkLength - Actual failed chunk length
     * @param {number} minChunkSize - Minimum allowed chunk size
     * @param {number} retryAttempt - Zero-based retry attempt count
     * @returns {number} Next chunk size cap
     */
    getReducedChunkSize(currentChunkSize, failedChunkLength, minChunkSize, retryAttempt) {
        const stageFactors = [0.65, 0.5, 0.4];
        const factor = stageFactors[Math.min(retryAttempt, stageFactors.length - 1)];

        const basedOnFailedChunk = Math.floor(failedChunkLength * factor);
        const basedOnCurrentSize = Math.floor(currentChunkSize * factor);
        let nextSize = Math.min(basedOnFailedChunk, basedOnCurrentSize);

        if (Number.isNaN(nextSize) || !Number.isFinite(nextSize)) {
            nextSize = Math.floor(currentChunkSize * 0.5);
        }

        nextSize = Math.max(minChunkSize, nextSize);

        if (nextSize >= currentChunkSize) {
            const fallback = Math.max(minChunkSize, Math.floor(currentChunkSize * 0.8));
            if (fallback < currentChunkSize) {
                nextSize = fallback;
            }
        }

        return nextSize;
    }

    /**
     * Count chunks from line array starting at a given index and strategy.
     *
     * @param {Array} lines - Markdown lines
     * @param {number} startIndex - Starting line index
     * @param {number} maxChunkSize - Maximum size per chunk
     * @param {string} chunkStrategy - one of: none, h2, h3, h4, h5, h6
     * @returns {number} Estimated chunk count
     */
    countChunksFromLines(lines, startIndex, maxChunkSize, chunkStrategy = 'h3') {
        let count = 0;
        let index = startIndex;

        while (index < lines.length) {
            const { nextIndex } = this.buildNextChunkWithStrategy(lines, index, maxChunkSize, chunkStrategy);
            if (nextIndex === index) {
                break;
            }
            count += 1;
            index = nextIndex;
        }

        return count;
    }

    /**
     * Count heading levels (H2-H6) outside fenced code blocks.
     *
     * @param {Array} lines - Markdown lines
     * @returns {object} Heading counts by level
     */
    getHeadingLevelCounts(lines) {
        let inCodeBlock = false;
        let fenceChar = null;
        let fenceLen = 0;

        const counts = {
            h2: 0,
            h3: 0,
            h4: 0,
            h5: 0,
            h6: 0
        };

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
                } else if (currentChar === fenceChar && currentLen >= fenceLen) {
                    inCodeBlock = false;
                    fenceChar = null;
                    fenceLen = 0;
                }

                continue;
            }

            if (inCodeBlock) {
                continue;
            }

            const headingMatch = line.match(/^\s{0,3}(#{2,6})\s+\S/);
            if (!headingMatch) {
                continue;
            }

            const level = headingMatch[1].length;
            const key = `h${level}`;
            if (Object.prototype.hasOwnProperty.call(counts, key)) {
                counts[key] += 1;
            }
        }

        return counts;
    }

    /**
     * Choose an initial chunk strategy using file size and heading density.
     *
     * @param {Array} lines - Markdown lines
     * @param {number} contentLength - Content length in bytes/chars
     * @param {number} maxChunkSize - Maximum size per chunk
     * @returns {string} Initial chunk strategy
     */
    chooseInitialChunkStrategy(lines, contentLength, maxChunkSize) {
        const headingCounts = this.getHeadingLevelCounts(lines);
        const targetMidpoint = Math.floor((MarkdownTranslator.CHUNK_TARGET_MIN + MarkdownTranslator.CHUNK_TARGET_MAX) / 2);

        const preferStructuredBoundaries = contentLength > (maxChunkSize * 1.5);
        const candidateOrder = preferStructuredBoundaries ?
            ['h2', 'h3', 'h4', 'h5', 'h6', 'none'] :
            ['none', 'h2', 'h3', 'h4', 'h5', 'h6'];

        let bestStrategy = candidateOrder[0];
        let bestDistance = Number.POSITIVE_INFINITY;
        let bestEstimated = Number.POSITIVE_INFINITY;

        for (const strategy of candidateOrder) {
            if (strategy !== 'none' && headingCounts[strategy] === 0) {
                continue;
            }

            const estimated = this.countChunksFromLines(lines, 0, maxChunkSize, strategy);

            if (estimated >= MarkdownTranslator.CHUNK_TARGET_MIN && estimated <= MarkdownTranslator.CHUNK_TARGET_MAX) {
                return strategy;
            }

            const distance = Math.abs(estimated - targetMidpoint);
            if (distance < bestDistance || (distance === bestDistance && estimated < bestEstimated)) {
                bestDistance = distance;
                bestEstimated = estimated;
                bestStrategy = strategy;
            }
        }

        return bestStrategy;
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
        // Strip HTML comments before translation (comments cause model confusion)
        const { commentlessContent, commentsMap } = this.stripHtmlComments(content);

        const lines = commentlessContent.split('\n');
        let currentChunkSize = MarkdownTranslator.DEFAULT_CHUNK_SIZE;
        const minChunkSize = MarkdownTranslator.MIN_CHUNK_SIZE;
        const translatedChunks = [];

        let currentChunkStrategy = this.chooseInitialChunkStrategy(
            lines,
            commentlessContent.length,
            currentChunkSize
        );

        let index = 0;
        let chunkIndex = 0;
        let estimatedTotal = this.countChunksFromLines(lines, index, currentChunkSize, currentChunkStrategy);

        const headingCounts = this.getHeadingLevelCounts(lines);

        console.log(chalk.blue(
            `Translating ${estimatedTotal} chunk(s) from ${sourceLanguage} to ${targetLanguage} ` +
            `(strategy: ${currentChunkStrategy}, size: ${currentChunkSize})...`
        ));
        console.log(chalk.gray(`Heading counts: ${JSON.stringify(headingCounts)}`));

        while (index < lines.length) {
            if (progressCallback) {
                progressCallback(chunkIndex + 1, estimatedTotal);
            }

            let attempt = 0;
            let translated = null;
            let chunk = '';
            let nextIndex = index;
            let chunkStrategyForAttempt = currentChunkStrategy;

            while (true) {
                const built = this.buildNextChunkWithStrategy(lines, index, currentChunkSize, chunkStrategyForAttempt);
                chunk = built.chunk;
                nextIndex = built.nextIndex;

                if (!chunk) {
                    break;
                }

                // eslint-disable-next-line no-await-in-loop
                translated = await this.translateChunk(chunk, targetLanguage, sourceLanguage);

                // Always check completeness for this chunk
                const chunkStats = this.getMarkdownStats(chunk);
                const translatedStats = this.getMarkdownStats(translated.text);
                const mismatches = this.getCompletenessMismatches(chunk, translated.text);

                // Log chunk completeness with full details
                console.log(chalk.gray(`[chunk ${chunkIndex + 1}/${estimatedTotal}] completeness check: Original(H:${chunkStats.headings},C:${chunkStats.codeBlocks}) vs Translated(H:${translatedStats.headings},C:${translatedStats.codeBlocks}) - ${mismatches.length === 0 ? '✅ PASS' : '❌ FAIL'}`));

                // Always log chunk metadata and comparison results
                this.logChunkMetadata(chunkIndex + 1, estimatedTotal, translated.metadata, mismatches);

                const finishReason = translated.metadata?.finishReason || '';
                const isStopFinish = finishReason === 'STOP';
                const hasNonStopFinish = !isStopFinish;
                const hasMismatches = mismatches.length > 0;
                const finerStrategy = hasMismatches ? this.getNextFinerChunkStrategy(chunkStrategyForAttempt) : null;
                const canReduceSize = currentChunkSize > minChunkSize;
                const shouldRetryForFailure = hasNonStopFinish || hasMismatches;
                const shouldRetry =
                    shouldRetryForFailure &&
                    attempt < MarkdownTranslator.CHUNK_RETRY_LIMIT &&
                    (canReduceSize || Boolean(finerStrategy));

                if (!shouldRetry) {
                    // Log failure but continue (allow tech writer to hand-edit)
                    if (hasMismatches) {
                        console.warn(chalk.yellow(`⚠️  Chunk ${chunkIndex + 1} has unresolved mismatches: ${mismatches.join('; ')} - continuing with next chunk`));
                    }
                    if (hasNonStopFinish) {
                        console.warn(chalk.yellow(`⚠️  Chunk ${chunkIndex + 1} ended with finishReason=${finishReason} and could not be retried further - continuing with next chunk`));
                    }
                    break;
                }

                // Any non-STOP finish reason must retry with smaller chunk size.
                if (hasNonStopFinish) {
                    const nextSize = this.getReducedChunkSize(
                        currentChunkSize,
                        chunk.length,
                        minChunkSize,
                        attempt
                    );

                    if (nextSize === currentChunkSize) {
                        console.warn(chalk.yellow(`⚠️  Chunk ${chunkIndex + 1} finishReason=${finishReason} but chunk size cannot be reduced further (${currentChunkSize})`));
                        break;
                    }

                    attempt += 1;
                    currentChunkSize = nextSize;
                    estimatedTotal = chunkIndex + this.countChunksFromLines(lines, index, currentChunkSize, currentChunkStrategy);
                    console.warn(chalk.yellow(
                        `Retrying chunk ${chunkIndex + 1} with smaller size: ${currentChunkSize} ` +
                        `(finishReason: ${finishReason}, failedChunkLength: ${chunk.length}, strategy: ${currentChunkStrategy})`
                    ));
                    continue;
                }

                // On mismatch, move to a finer section boundary first and keep it globally.
                if (hasMismatches) {
                    if (finerStrategy) {
                        attempt += 1;
                        chunkStrategyForAttempt = finerStrategy;
                        currentChunkStrategy = finerStrategy;
                        estimatedTotal = chunkIndex + this.countChunksFromLines(lines, index, currentChunkSize, currentChunkStrategy);
                        console.warn(chalk.yellow(
                            `Retrying chunk ${chunkIndex + 1} with finer strategy: ${currentChunkStrategy}`
                        ));
                        continue;
                    }
                }

                const nextSize = this.getReducedChunkSize(
                    currentChunkSize,
                    chunk.length,
                    minChunkSize,
                    attempt
                );
                if (nextSize === currentChunkSize) {
                    break;
                }

                attempt += 1;
                currentChunkSize = nextSize;
                estimatedTotal = chunkIndex + this.countChunksFromLines(lines, index, currentChunkSize, currentChunkStrategy);
                console.warn(chalk.yellow(
                    `Retrying chunk ${chunkIndex + 1} with smaller size: ${currentChunkSize} ` +
                    `(strategy: ${currentChunkStrategy})`
                ));
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

        // Restore HTML comments
        const contentWithComments = this.restoreHtmlComments(finalContent, commentsMap);

        return contentWithComments;
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
     * Strip HTML comments from content and store them for later restoration.
     *
     * @param {string} content - Content with HTML comments
     * @returns {object} Object with commentlessContent and commentsMap
     */
    stripHtmlComments(content) {
        const commentsMap = [];
        let placeholder = 0;
        const commentlessContent = content.replace(
            /<!--(?:(?!<!--)[\s\S])*?-->/g,
            (match) => {
                commentsMap.push(match);
                return `__HTML_COMMENT_${placeholder++}__`;
            }
        );
        return { commentlessContent, commentsMap };
    }

    /**
     * Restore HTML comments that were stripped from content.
     *
     * @param {string} content - Content with comment placeholders
     * @param {Array} commentsMap - Array of comments to restore
     * @returns {string} Content with comments restored
     */
    restoreHtmlComments(content, commentsMap) {
        let result = content;
        commentsMap.forEach((comment, index) => {
            result = result.replace(`__HTML_COMMENT_${index}__`, comment);
        });
        return result;
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

            // Final check of entire file and always log result
            // Strip comments for accurate comparison (comments are preserved as-is)
            const { commentlessContent: originalNoComments } = this.stripHtmlComments(content);
            const { commentlessContent: translatedNoComments } = this.stripHtmlComments(translatedContent);

            // Get stats for both versions
            const originalStats = this.getMarkdownStats(originalNoComments);
            const translatedStats = this.getMarkdownStats(translatedNoComments);

            const finalMismatches = this.getCompletenessMismatches(originalNoComments, translatedNoComments);
            console.log(chalk.gray(`[final check] Entire file completeness: Original(H:${originalStats.headings},C:${originalStats.codeBlocks}) vs Translated(H:${translatedStats.headings},C:${translatedStats.codeBlocks}) - ${finalMismatches.length === 0 ? '✅ PASS' : '❌ FAIL'} ${finalMismatches.length > 0 ? `(${finalMismatches.join('; ')})` : ''}`));

            if (finalMismatches.length > 0) {
                throw new Error(`Final translation completeness check failed: ${finalMismatches.join('; ')}`);
            }

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
            // If we have translated content, always write as .invalid on any error
            if (translatedContent) {
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
