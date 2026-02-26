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

    createAstTranslationPrompt(items, targetLanguage, sourceLanguage) {
        const payload = JSON.stringify(items);

        return `Translate each item's text from ${sourceLanguage} to ${targetLanguage}.\n\nRules:\n1) Return ONLY a JSON array.\n2) Keep each id exactly as-is.\n3) Translate only text values.\n4) Do not add or remove items.\n5) Do not include explanations or markdown code fences.\n\nInput JSON:\n${payload}`;
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

    async translateEntryChunk(items, targetLanguage, sourceLanguage) {
        const prompt = this.createAstTranslationPrompt(items, targetLanguage, sourceLanguage);
        const result = await this.model.generateContent(prompt);
        const response = await result.response;
        const translatedItems = this.parseJsonArrayFromModelText(response.text());

        const byId = new Map();
        for (const item of translatedItems) {
            if (typeof item?.id !== 'number' || typeof item?.text !== 'string') {
                throw new Error('Model returned invalid item format for AST translation');
            }
            byId.set(item.id, item.text);
        }

        const merged = items.map((item) => {
            if (!byId.has(item.id)) {
                throw new Error(`Model response missing id ${item.id}`);
            }
            return {
                id: item.id,
                text: byId.get(item.id)
            };
        });

        return merged;
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

    async translateMarkdownAstMvp(
        content,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback
    ) {
        const { skeleton, entries } = this.extractTranslatableContent(content);

        if (entries.length === 0) {
            return content;
        }

        const chunks = this.splitEntriesForTranslation(entries);
        const translatedEntries = [];

        for (let index = 0; index < chunks.length; index += 1) {
            if (progressCallback) {
                progressCallback(index + 1, chunks.length);
            }

            const items = chunks[index];
            // eslint-disable-next-line no-await-in-loop
            const translated = await this.translateEntryChunk(items, targetLanguage, sourceLanguage);
            translatedEntries.push(...translated);
        }

        const translatedContent = this.restoreTranslatedContent(skeleton, translatedEntries);
        return translatedContent.endsWith('\n') ? translatedContent : `${translatedContent}\n`;
    }

    async translateFileAstMvp(
        inputPath,
        outputPath,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback
    ) {
        if (!await fs.pathExists(inputPath)) {
            throw new Error(`Input file does not exist: ${inputPath}`);
        }

        const content = await fs.readFile(inputPath, 'utf8');
        if (!content.trim()) {
            throw new Error('Input file is empty');
        }

        const translated = await this.translateMarkdownAstMvp(
            content,
            targetLanguage,
            sourceLanguage,
            progressCallback
        );

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
    }

    async translateFile(
        inputPath,
        outputPath,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false
    ) {
        if (logChunkMetadata) {
            console.log('AST MVP mode: chunk metadata logging is not available for this pipeline.');
        }

        return await this.translateFileAstMvp(
            inputPath,
            outputPath,
            targetLanguage,
            sourceLanguage,
            progressCallback
        );
    }
}

export default AstMarkdownTranslator;
