import path from 'path';

import fs from 'fs-extra';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import MarkdownTranslator from './translator.js';

class AstMarkdownTranslator extends MarkdownTranslator {
    static AST_CHUNK_MAX_CHARS = 12000;

    static AST_CHUNK_MAX_ITEMS = 40;

    static AST_SPLIT_RETRY_MAX_DEPTH = 6;

    createAstParser() {
        return unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkMdx);
    }

    createAstStringifier() {
        return unified()
        .use(remarkFrontmatter, ['yaml'])
        .use(remarkStringify, { fences: true, bullet: '-', listItemIndent: 'one' })
        .use(remarkMdx);
    }

    buildPlaceholder(id) {
        return `__MTX_${id}__`;
    }

    isSkippableTextParent(parentType) {
        return ['code', 'inlineCode', 'yaml', 'html', 'math', 'inlineMath', 'mdxjsEsm'].includes(parentType);
    }

    shouldTranslateValue(value) {
        return Boolean(value && value.trim());
    }

    extractTranslatableContent(content) {
        const parser = this.createAstParser();
        const stringifier = this.createAstStringifier();
        const tree = parser.parse(content);

        const entries = [];
        let nextId = 1;

        const registerEntry = (currentValue, assignValue) => {
            if (!this.shouldTranslateValue(currentValue)) {
                return;
            }

            const id = nextId;
            const placeholder = this.buildPlaceholder(id);
            entries.push({ id, text: currentValue });
            assignValue(placeholder);
            nextId += 1;
        };

        visit(tree, 'text', (node, index, parent) => {
            if (!parent || this.isSkippableTextParent(parent.type)) {
                return;
            }

            registerEntry(node.value, (placeholder) => {
                node.value = placeholder;
            });
        });

        visit(tree, 'image', (node) => {
            registerEntry(node.alt, (placeholder) => {
                node.alt = placeholder;
            });
            registerEntry(node.title, (placeholder) => {
                node.title = placeholder;
            });
        });

        visit(tree, 'link', (node) => {
            registerEntry(node.title, (placeholder) => {
                node.title = placeholder;
            });
        });

        visit(tree, 'definition', (node) => {
            registerEntry(node.title, (placeholder) => {
                node.title = placeholder;
            });
        });

        const skeleton = stringifier.stringify(tree);

        return {
            skeleton,
            entries
        };
    }

    splitEntriesForTranslation(entries) {
        const chunks = [];
        let current = [];
        let currentChars = 0;

        for (const entry of entries) {
            const entryChars = entry.text.length;

            if (
                current.length > 0 &&
                (
                    current.length >= AstMarkdownTranslator.AST_CHUNK_MAX_ITEMS ||
                    currentChars + entryChars > AstMarkdownTranslator.AST_CHUNK_MAX_CHARS
                )
            ) {
                chunks.push(current);
                current = [];
                currentChars = 0;
            }

            current.push(entry);
            currentChars += entryChars;
        }

        if (current.length > 0) {
            chunks.push(current);
        }

        return chunks;
    }

    logChunkMetadata(index, total, metadata, notes = []) {
        const noteText = notes.length > 0 ? `; notes: ${notes.join('; ')}` : '';
        const summary = {
            finishReason: metadata?.finishReason || undefined,
            usageMetadata: metadata?.usageMetadata || undefined,
            promptFeedback: metadata?.promptFeedback || undefined,
            safetyRatings: metadata?.safetyRatings || undefined,
            candidates: metadata?.candidates || undefined
        };

        console.log(`[chunk ${index}/${total}] metadata${noteText}: ${JSON.stringify(summary)}`);
    }

    createAstTranslationPrompt(items, targetLanguage, sourceLanguage) {
        const payload = JSON.stringify(items);

        return `Translate each item's text from ${sourceLanguage} to ${targetLanguage}.\n\nRules:\n1) Return ONLY a JSON array.\n2) Keep each id exactly as-is.\n3) Translate only text values.\n4) Do not add or remove items.\n5) Do not include explanations or markdown code fences.\n\nInput JSON:\n${payload}`;
    }

    createAstTranslationRepairPrompt(items, targetLanguage, sourceLanguage, parseErrorMessage) {
        const basePrompt = this.createAstTranslationPrompt(items, targetLanguage, sourceLanguage);
        return `${basePrompt}\n\nYour previous response could not be parsed as JSON (${parseErrorMessage}). Return STRICT valid JSON only.`;
    }

    parseJsonArrayFromModelText(text) {
        const trimmed = text.trim();

        const stripFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

        const repairInvalidEscapes = candidate => candidate.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');

        const tryParse = (candidate) => {
            const parsed = JSON.parse(candidate);
            if (!Array.isArray(parsed)) {
                throw new Error('Model response is not a JSON array');
            }
            return parsed;
        };

        try {
            return tryParse(stripFence);
        } catch {
            try {
                return tryParse(repairInvalidEscapes(stripFence));
            } catch {
                // Continue to bracket extraction fallback.
            }

            const start = stripFence.indexOf('[');
            const end = stripFence.lastIndexOf(']');
            if (start >= 0 && end > start) {
                const candidate = stripFence.slice(start, end + 1);
                try {
                    return tryParse(candidate);
                } catch {
                    return tryParse(repairInvalidEscapes(candidate));
                }
            }
            throw new Error('Unable to parse JSON array from model response');
        }
    }

    mergeAstTranslationItems(items, translatedItems) {
        const byId = new Map();
        let invalidItemCount = 0;

        for (const item of translatedItems) {
            const normalizedId = typeof item?.id === 'number' ? item.id : Number(item?.id);
            if (!Number.isInteger(normalizedId) || typeof item?.text !== 'string') {
                invalidItemCount += 1;
                continue;
            }
            byId.set(normalizedId, item.text);
        }

        const missingIds = [];
        const merged = items.map((item) => {
            if (!byId.has(item.id)) {
                missingIds.push(item.id);
                return {
                    id: item.id,
                    text: item.text
                };
            }

            return {
                id: item.id,
                text: byId.get(item.id)
            };
        });

        return {
            merged,
            missingIds,
            invalidItemCount
        };
    }

    async requestParsedAstItems(items, targetLanguage, sourceLanguage) {
        const prompt = this.createAstTranslationPrompt(items, targetLanguage, sourceLanguage);
        const result = await this.model.generateContent(prompt);
        const response = await result.response;
        const metadata = this.extractChunkMetadata(response);

        try {
            return {
                translatedItems: this.parseJsonArrayFromModelText(response.text()),
                metadata,
                repairMetadata: null,
                parseWarnings: []
            };
        } catch (initialParseError) {
            const repairPrompt = this.createAstTranslationRepairPrompt(
                items,
                targetLanguage,
                sourceLanguage,
                initialParseError.message
            );
            const repairResult = await this.model.generateContent(repairPrompt);
            const repairResponse = await repairResult.response;
            const repairMetadata = this.extractChunkMetadata(repairResponse);

            try {
                return {
                    translatedItems: this.parseJsonArrayFromModelText(repairResponse.text()),
                    metadata,
                    repairMetadata,
                    parseWarnings: [`initial parse failed: ${initialParseError.message}`]
                };
            } catch (repairParseError) {
                return {
                    translatedItems: [],
                    metadata,
                    repairMetadata,
                    parseWarnings: [
                        `initial parse failed: ${initialParseError.message}`,
                        `repair parse failed: ${repairParseError.message}`
                    ]
                };
            }
        }
    }

    async recoverMissingIdsWithSplit(items, targetLanguage, sourceLanguage, splitDepth) {
        if (items.length === 0) {
            return {
                recovered: [],
                unresolvedIds: [],
                invalidItemCount: 0
            };
        }

        if (splitDepth >= AstMarkdownTranslator.AST_SPLIT_RETRY_MAX_DEPTH || items.length === 1) {
            const leafResult = await this.translateEntryChunk(items, targetLanguage, sourceLanguage, {
                allowSplitFallback: false,
                splitDepth
            });

            const unresolvedSet = new Set(leafResult.missingIds);
            return {
                recovered: leafResult.merged.filter(item => !unresolvedSet.has(item.id)),
                unresolvedIds: leafResult.missingIds,
                invalidItemCount: leafResult.invalidItemCount
            };
        }

        const midpoint = Math.floor(items.length / 2);
        const leftItems = items.slice(0, midpoint);
        const rightItems = items.slice(midpoint);

        const leftResult = await this.recoverMissingIdsWithSplit(
            leftItems,
            targetLanguage,
            sourceLanguage,
            splitDepth + 1
        );

        const rightResult = await this.recoverMissingIdsWithSplit(
            rightItems,
            targetLanguage,
            sourceLanguage,
            splitDepth + 1
        );

        return {
            recovered: [...leftResult.recovered, ...rightResult.recovered],
            unresolvedIds: [...leftResult.unresolvedIds, ...rightResult.unresolvedIds],
            invalidItemCount: leftResult.invalidItemCount + rightResult.invalidItemCount
        };
    }

    async translateEntryChunk(items, targetLanguage, sourceLanguage, options = {}) {
        const {
            allowSplitFallback = true,
            splitDepth = 0
        } = options;

        const initialRequest = await this.requestParsedAstItems(items, targetLanguage, sourceLanguage);
        const metadata = initialRequest.metadata;
        let translatedItems = initialRequest.translatedItems;
        const parseWarnings = [...initialRequest.parseWarnings];
        const parseRecoveryMetadata = initialRequest.repairMetadata;

        const {
            merged,
            missingIds: initialMissingIds,
            invalidItemCount
        } = this.mergeAstTranslationItems(items, translatedItems);

        let resolvedMerged = merged;
        let remainingMissingIds = initialMissingIds;
        let totalInvalidItemCount = invalidItemCount;
        let finalMissingIds = remainingMissingIds;

        let retryMetadata = null;

        if (initialMissingIds.length > 0) {
            const retryItems = items.filter(item => initialMissingIds.includes(item.id));
            const retryRequest = await this.requestParsedAstItems(retryItems, targetLanguage, sourceLanguage);
            retryMetadata = retryRequest.metadata;
            translatedItems = retryRequest.translatedItems;
            parseWarnings.push(...retryRequest.parseWarnings.map(warning => `missing-id retry: ${warning}`));

            const retryMerged = this.mergeAstTranslationItems(retryItems, translatedItems);
            totalInvalidItemCount += retryMerged.invalidItemCount;

            const retryById = new Map(retryMerged.merged.map(item => [item.id, item.text]));
            resolvedMerged = resolvedMerged.map((item) => {
                if (retryById.has(item.id)) {
                    return {
                        id: item.id,
                        text: retryById.get(item.id)
                    };
                }
                return item;
            });

            remainingMissingIds = retryMerged.missingIds;
        }

        if (allowSplitFallback && finalMissingIds.length > 0 && items.length > 1) {
            const unresolvedIdsForSplit = [...finalMissingIds];
            const unresolvedItems = items.filter(item => unresolvedIdsForSplit.includes(item.id));
            const splitRecovery = await this.recoverMissingIdsWithSplit(
                unresolvedItems,
                targetLanguage,
                sourceLanguage,
                splitDepth + 1
            );

            totalInvalidItemCount += splitRecovery.invalidItemCount;

            if (splitRecovery.recovered.length > 0) {
                const recoveredById = new Map(splitRecovery.recovered.map(item => [item.id, item.text]));
                resolvedMerged = resolvedMerged.map((item) => {
                    if (recoveredById.has(item.id)) {
                        return {
                            id: item.id,
                            text: recoveredById.get(item.id)
                        };
                    }
                    return item;
                });
            }

            if (splitRecovery.recovered.length > 0 || splitRecovery.unresolvedIds.length > 0) {
                parseWarnings.push(
                    `split fallback recovered ${splitRecovery.recovered.length}/${unresolvedItems.length} missing ids`
                );
            }

            finalMissingIds = splitRecovery.unresolvedIds;
        }

        return {
            merged: resolvedMerged,
            metadata,
            parseRecoveryMetadata,
            retryMetadata,
            missingIds: finalMissingIds,
            invalidItemCount: totalInvalidItemCount,
            parseWarnings
        };
    }

    restoreTranslatedContent(skeleton, translatedEntries) {
        let output = skeleton;

        for (const entry of translatedEntries) {
            const placeholder = this.buildPlaceholder(entry.id);
            const escapedPlaceholder = placeholder.replaceAll('_', '\\_');
            output = output.split(placeholder).join(entry.text);
            output = output.split(escapedPlaceholder).join(entry.text);
        }

        return output;
    }

    isEnglishTarget(targetLanguage) {
        if (!targetLanguage) {
            return false;
        }

        const normalized = targetLanguage.toString().trim().toLowerCase();
        return normalized === 'en' || normalized.includes('english');
    }

    normalizeEnglishInlineCodeSpacing(content) {
        const parser = this.createAstParser();
        const stringifier = this.createAstStringifier();
        const tree = parser.parse(content);

        const shouldAddTrailingSpace = value => /[a-z0-9]$/i.test(value) && !/\s$/.test(value);
        const shouldAddLeadingSpace = value => /^[a-z0-9]/i.test(value) && !/^\s/.test(value);

        visit(tree, node => Array.isArray(node?.children), (node) => {
            for (let index = 0; index < node.children.length; index += 1) {
                const child = node.children[index];
                if (child?.type !== 'inlineCode') {
                    continue;
                }

                const previous = node.children[index - 1];
                if (previous?.type === 'text' && previous.value && shouldAddTrailingSpace(previous.value)) {
                    previous.value += ' ';
                }

                const next = node.children[index + 1];
                if (next?.type === 'text' && next.value && shouldAddLeadingSpace(next.value)) {
                    next.value = ` ${next.value}`;
                }
            }
        });

        const normalized = stringifier.stringify(tree);
        return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
    }

    async translateMarkdownAstMvp(
        content,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false
    ) {
        const { skeleton, entries } = this.extractTranslatableContent(content);

        if (entries.length === 0) {
            return content;
        }

        const chunks = this.splitEntriesForTranslation(entries);
        const translatedEntries = [];
        let passedChunks = 0;
        let failedChunks = 0;
        let parseRepairCount = 0;
        let missingIdRetryCount = 0;
        let fallbackChunkCount = 0;
        let fallbackItemCount = 0;

        for (let index = 0; index < chunks.length; index += 1) {
            if (progressCallback) {
                progressCallback(index + 1, chunks.length);
            }

            const items = chunks[index];
            // eslint-disable-next-line no-await-in-loop
            const translated = await this.translateEntryChunk(items, targetLanguage, sourceLanguage);
            translatedEntries.push(...translated.merged);

            const translatedCount = items.length - translated.missingIds.length;
            const hasMissingIds = translated.missingIds.length > 0;
            const completenessStatus = !hasMissingIds ? '✅ PASS' : '❌ FAIL';
            const details = [];

            if (translated.parseRecoveryMetadata) {
                parseRepairCount += 1;
            }
            if (translated.retryMetadata) {
                missingIdRetryCount += 1;
            }

            if (hasMissingIds) {
                details.push(`missing ids: ${translated.missingIds.join(', ')}`);
                fallbackChunkCount += 1;
                fallbackItemCount += translated.missingIds.length;
            }
            if (translated.invalidItemCount > 0) {
                details.push(`invalid items ignored: ${translated.invalidItemCount}`);
            }

            if (hasMissingIds) {
                failedChunks += 1;
            } else {
                passedChunks += 1;
            }

            if (logChunkMetadata) {
                const notes = [];
                if (translated.missingIds.length > 0) {
                    notes.push(`missing ids after retry: ${translated.missingIds.join(', ')}`);
                }
                if (translated.invalidItemCount > 0) {
                    notes.push(`invalid items ignored: ${translated.invalidItemCount}`);
                }
                if (translated.parseWarnings.length > 0) {
                    notes.push(...translated.parseWarnings);
                }

                this.logChunkMetadata(index + 1, chunks.length, translated.metadata, notes);

                if (translated.parseRecoveryMetadata) {
                    this.logChunkMetadata(index + 1, chunks.length, translated.parseRecoveryMetadata, ['json repair retry']);
                }

                if (translated.retryMetadata) {
                    this.logChunkMetadata(index + 1, chunks.length, translated.retryMetadata, ['retry for missing ids']);
                }
            }

            console.log(
                `[chunk ${index + 1}/${chunks.length}] AST completeness check: ` +
                `Translated IDs ${translatedCount}/${items.length} - ${completenessStatus}` +
                `${details.length > 0 ? ` (${details.join('; ')})` : ''}`
            );
        }

        const chunkSummaryStatus = failedChunks === 0 ? 'PASS' : 'FAIL';
        console.log(
            `[AST per-chunk summary] check=translated_ids status=${chunkSummaryStatus} ` +
            `(passed: ${passedChunks}, failed: ${failedChunks}, total: ${chunks.length})`
        );
        console.log(
            `[AST health] parse_repairs=${parseRepairCount} ` +
            `missing_id_retries=${missingIdRetryCount} ` +
            `fallback_chunks=${fallbackChunkCount} fallback_items=${fallbackItemCount}`
        );

        const translatedContent = this.restoreTranslatedContent(skeleton, translatedEntries);
        if (this.isEnglishTarget(targetLanguage)) {
            return this.normalizeEnglishInlineCodeSpacing(translatedContent);
        }

        return translatedContent.endsWith('\n') ? translatedContent : `${translatedContent}\n`;
    }

    async translateFileAstMvp(
        inputPath,
        outputPath,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false
    ) {
        let translated = null;

        if (!await fs.pathExists(inputPath)) {
            throw new Error(`Input file does not exist: ${inputPath}`);
        }

        const content = await fs.readFile(inputPath, 'utf8');
        if (!content.trim()) {
            throw new Error('Input file is empty');
        }

        try {
            translated = await this.translateMarkdownAstMvp(
                content,
                targetLanguage,
                sourceLanguage,
                progressCallback,
                logChunkMetadata
            );

            const { commentlessContent: originalNoComments } = this.stripHtmlComments(content);
            const { commentlessContent: translatedNoComments } = this.stripHtmlComments(translated);
            const originalStats = this.getMarkdownStats(originalNoComments);
            const translatedStats = this.getMarkdownStats(translatedNoComments);
            const finalMismatches = this.getCompletenessMismatches(originalNoComments, translatedNoComments);

            const finalStatus = finalMismatches.length === 0 ? 'PASS' : 'FAIL';
            console.log(
                `[final check] Status=${finalStatus} ` +
                `(Original headings:${originalStats.headings}, code blocks:${originalStats.codeBlocks}; ` +
                `Translated headings:${translatedStats.headings}, code blocks:${translatedStats.codeBlocks})` +
                `${finalMismatches.length > 0 ? ` (mismatches: ${finalMismatches.join('; ')})` : ''}`
            );

            if (finalMismatches.length > 0) {
                throw new Error(`Final translation completeness check failed: ${finalMismatches.join('; ')}`);
            }

            await fs.ensureDir(path.dirname(outputPath));
            await fs.writeFile(outputPath, translated, 'utf8');

            return {
                inputPath,
                outputPath,
                sourceLanguage,
                targetLanguage,
                originalLength: content.length,
                translatedLength: translated.length
            };
        } catch (error) {
            if (translated) {
                const invalidPath = outputPath.endsWith('.md') || outputPath.endsWith('.markdown') || outputPath.endsWith('.mdx') ?
                    outputPath.replace(/\.(md|markdown|mdx)$/, '.invalid') :
                    `${outputPath}.invalid`;

                await fs.ensureDir(path.dirname(invalidPath));
                await fs.writeFile(invalidPath, translated, 'utf8');
                console.error(`❌ Translation failed - incomplete output written to: ${invalidPath}`);
            }

            throw error;
        }
    }

    async translateFile(
        inputPath,
        outputPath,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false
    ) {
        return await this.translateFileAstMvp(
            inputPath,
            outputPath,
            targetLanguage,
            sourceLanguage,
            progressCallback,
            logChunkMetadata
        );
    }
}

export default AstMarkdownTranslator;
