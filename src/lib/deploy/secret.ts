import { randomBytes } from "node:crypto";

export async function getOrCreateDeploySecret(
  filePath: string,
): Promise<string> {
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return (await file.text()).trim();
  }

  const secret = randomBytes(32).toString("hex");
  await Bun.write(filePath, secret);
  return secret;
}
