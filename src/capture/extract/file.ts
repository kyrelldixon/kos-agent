export async function extractFileContent(filePath: string): Promise<string> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return "";
    return await file.text();
  } catch {
    return "";
  }
}
