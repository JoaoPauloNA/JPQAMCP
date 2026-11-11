// Baixa uma vez o modelo de português do tesseract (motor portátil de OCR) para a pasta .tessdata.
// Roda sozinho depois do `npm install`; se falhar (sem internet), o modelo é baixado na primeira execução.
import { createWorker } from "tesseract.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const aqui = dirname(fileURLToPath(import.meta.url));
try {
  const w = await createWorker("por", 1, { cachePath: join(aqui, ".tessdata"), logger: () => {} });
  await w.terminate();
  console.error("modelo de OCR pronto");
} catch (e) { console.error("modelo de OCR será baixado na primeira execução:", e.message); }
process.exit(0);
