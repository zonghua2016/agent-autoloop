import { createHash } from "node:crypto";
export function repositorySubject(repository: string, number: number) {
  const full = `${repository}#${number}`;
  return full.length <= 100
    ? full
    : `codeup-${createHash("sha256").update(repository).digest("hex").slice(0, 24)}#${number}`;
}
