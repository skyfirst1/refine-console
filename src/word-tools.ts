import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

function wordRuntime(): { python: string; helper: string; renderer: string; outputDir: string } {
  const python = process.env.WORD_PYTHON?.trim();
  const helper = process.env.WORD_HELPER_SCRIPT?.trim();
  const renderer = process.env.WORD_RENDER_SCRIPT?.trim();
  const outputDir = process.env.WORD_OUTPUT_DIR?.trim();
  if (!python || !helper || !renderer || !outputDir) {
    throw new Error("WORD_PYTHON, WORD_HELPER_SCRIPT, WORD_RENDER_SCRIPT, and WORD_OUTPUT_DIR are required");
  }
  return { python, helper, renderer, outputDir: resolve(outputDir) };
}

function safeDocxPath(outputDir: string, requested: string): string {
  const file = basename(requested.trim());
  if (!file || file === ".docx" || extname(file).toLowerCase() !== ".docx") {
    throw new Error("filename must be a simple .docx file name");
  }
  return resolve(outputDir, file);
}

async function runPython(python: string, args: string[], timeout = 120_000): Promise<string> {
  const result = await execFileAsync(python, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function registerWordTools(runtime: ExtensionAPI): void {
  runtime.registerTool({
    name: "word_create_document",
    label: "Create Word document",
    description: "Create a professionally formatted DOCX from final Markdown. Use this before rendering or inspecting the document.",
    parameters: Type.Object({
      filename: Type.String({ description: "Output file name ending in .docx; directories are not allowed" }),
      title: Type.String({ description: "Document title" }),
      markdown: Type.String({ description: "Complete final document body in Markdown" }),
    }),
    async execute(_id, params) {
      const env = wordRuntime();
      await mkdir(env.outputDir, { recursive: true });
      const docxPath = safeDocxPath(env.outputDir, params.filename);
      const sourcePath = docxPath.replace(/\.docx$/i, ".source.md");
      await writeFile(sourcePath, `${params.markdown.trim()}\n`, "utf8");
      const output = await runPython(env.python, [env.helper, "create", "--markdown", sourcePath, "--output", docxPath, "--title", params.title]);
      return {
        content: [{ type: "text", text: `Created ${docxPath}. ${output}` }],
        details: { docxPath, sourcePath, sourceCharacters: params.markdown.length },
      };
    },
  });

  runtime.registerTool({
    name: "word_render_document",
    label: "Render Word document",
    description: "Render a generated DOCX to page PNGs with LibreOffice. Always call this after creation and before delivery.",
    parameters: Type.Object({
      filename: Type.String({ description: "DOCX file name created by word_create_document" }),
    }),
    async execute(_id, params) {
      const env = wordRuntime();
      const docxPath = safeDocxPath(env.outputDir, params.filename);
      const renderDir = resolve(env.outputDir, `${basename(docxPath, ".docx")}-render`);
      const output = await runPython(env.python, [env.renderer, docxPath, "--output_dir", renderDir, "--emit_pdf"], 180_000);
      const manifest = JSON.parse(await runPython(env.python, [env.helper, "render-manifest", "--directory", renderDir]));
      return {
        content: [{ type: "text", text: `Rendered ${manifest.pageCount} pages to ${renderDir}.` }],
        details: { docxPath, renderDir, ...manifest, rendererOutput: output.slice(-2_000) },
      };
    },
  });

  runtime.registerTool({
    name: "word_inspect_document",
    label: "Inspect Word document",
    description: "Inspect DOCX structure, styles, tables, placeholders, and render outputs. Call this after rendering.",
    parameters: Type.Object({
      filename: Type.String({ description: "DOCX file name created by word_create_document" }),
    }),
    async execute(_id, params) {
      const env = wordRuntime();
      const docxPath = safeDocxPath(env.outputDir, params.filename);
      const renderDir = resolve(env.outputDir, `${basename(docxPath, ".docx")}-render`);
      const raw = await runPython(env.python, [env.helper, "inspect", "--input", docxPath, "--render-directory", renderDir]);
      const inspection = JSON.parse(raw);
      if (!inspection.pass) throw new Error(`Word inspection failed: ${JSON.stringify(inspection.checks)}`);
      return {
        content: [{ type: "text", text: `Inspection passed: ${inspection.paragraphs} paragraphs, ${inspection.tables} tables, ${inspection.renderedPages} rendered pages.` }],
        details: inspection,
      };
    },
  });
}

export async function readGeneratedWordSource(docxPath: string): Promise<string> {
  return readFile(docxPath.replace(/\.docx$/i, ".source.md"), "utf8");
}
