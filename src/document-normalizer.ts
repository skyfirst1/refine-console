import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { PRODUCTION_RULES } from "./production-rules.js";

export interface NormalizedDocument {
  sourcePath: string;
  sourceExtension: string;
  markdown: string;
  imagesOmitted: number;
}

interface MammothResult {
  value: string;
}

interface MammothImage {
  contentType: string;
}

interface MammothFacade {
  convertToMarkdown(
    input: { path: string },
    options?: { convertImage?: unknown },
  ): Promise<MammothResult>;
  images: {
    imgElement(handler: (image: MammothImage) => Promise<{ src: string; alt?: string }>): unknown;
  };
}

function stripEmbeddedImages(markdown: string): { markdown: string; count: number } {
  let count = 0;
  const replacement = () => {
    count += 1;
    return PRODUCTION_RULES.imagePlaceholder;
  };
  const cleaned = markdown
    .replace(/!\[[^\]]*\]\((?:data:image\/[^)]+|)\)/gi, replacement)
    .replace(/<img\b[^>]*>/gi, replacement)
    .replace(/(?:\r?\n){3,}/g, "\n\n")
    .trim();
  return { markdown: cleaned, count };
}

export async function normalizeDocumentToMarkdown(path: string): Promise<NormalizedDocument> {
  const sourcePath = resolve(path);
  const info = await stat(sourcePath);
  if (!info.isFile()) throw new Error(`Document artifact is not a file: ${sourcePath}`);
  const sourceExtension = extname(sourcePath).toLowerCase();
  if (!PRODUCTION_RULES.acceptedArtifactExtensions.includes(sourceExtension as never)) {
    throw new Error(`Unsupported document artifact extension: ${sourceExtension || "(none)"}`);
  }

  let raw: string;
  if (sourceExtension === ".docx") {
    const facade = mammoth as unknown as MammothFacade;
    const result = await facade.convertToMarkdown(
      { path: sourcePath },
      {
        convertImage: facade.images.imgElement(async () => ({
          src: "",
          // Keep the converter output syntactically simple; stripEmbeddedImages
          // replaces the whole Markdown image with the centralized placeholder.
          alt: "image omitted",
        })),
      },
    );
    raw = result.value;
  } else if (sourceExtension === ".pdf") {
    const parser = new PDFParse({ data: await readFile(sourcePath) });
    try {
      raw = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else {
    raw = await readFile(sourcePath, "utf8");
  }
  const stripped = stripEmbeddedImages(raw);
  return {
    sourcePath,
    sourceExtension,
    markdown: stripped.markdown,
    imagesOmitted: stripped.count,
  };
}
