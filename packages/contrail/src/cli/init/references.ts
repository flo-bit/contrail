import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { PrefixAnalysis, ReferenceCandidate } from "./analyze.js";

export interface InverseRelationChoice {
  name: string;
  groupBy?: string;
}

export interface ReferenceChoice {
  source: string;
  path: string;
  target: string;
  name: string;
  inverse?: InverseRelationChoice;
}

export type SemanticChoicePrompt = (
  analysis: PrefixAnalysis,
) => Promise<ReferenceChoice[]>;

function pluralize(value: string): string {
  if (value.endsWith("s")) return `${value}es`;
  if (value.endsWith("y") && !/[aeiou]y$/i.test(value)) {
    return `${value.slice(0, -1)}ies`;
  }
  return `${value}s`;
}

function pathName(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1] ?? "reference";
}

function uniqueName(base: string, used: Set<string>): string {
  let value = base;
  let suffix = 2;
  while (used.has(value)) value = `${base}${suffix++}`;
  used.add(value);
  return value;
}

async function chooseIndex(
  question: string,
  labels: string[],
  defaultIndex: number,
  ask: (question: string) => Promise<string>,
): Promise<number> {
  output.write(`${question}\n`);
  labels.forEach((label, index) => output.write(`  ${index}) ${label}\n`));
  const answer = (await ask(`Selection [${defaultIndex}]: `)).trim();
  if (answer === "") return defaultIndex;
  const selected = Number(answer);
  return Number.isInteger(selected) && selected >= 0 && selected < labels.length
    ? selected
    : defaultIndex;
}

async function askYesNo(
  question: string,
  defaultYes: boolean,
  ask: (question: string) => Promise<string>,
): Promise<boolean> {
  const answer = (
    await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)
  )
    .trim()
    .toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Ask only for semantics the Lexicon does not encode. */
export async function promptReferenceChoices(
  analysis: PrefixAnalysis,
): Promise<ReferenceChoice[]> {
  if (!input.isTTY || !output.isTTY) return [];
  const rl = createInterface({ input, output });
  const ask = (question: string) => rl.question(question);
  const choices: ReferenceChoice[] = [];
  const usedReferenceNames = new Map<string, Set<string>>();
  const usedRelationNames = new Map<string, Set<string>>();

  try {
    for (const source of analysis.collections) {
      for (const candidate of source.references) {
        const targetOptions = [
          "skip",
          ...analysis.collections.map(
            (collection) => `${collection.alias} (${collection.nsid})`,
          ),
        ];
        const selected = await chooseIndex(
          `\n${source.alias}.${candidate.path} is ${candidateLabel(candidate)}. Target collection?`,
          targetOptions,
          0,
          ask,
        );
        if (selected === 0) continue;
        const target = analysis.collections[selected - 1]!;
        const used = usedReferenceNames.get(source.alias) ?? new Set<string>();
        usedReferenceNames.set(source.alias, used);
        const defaultName = uniqueName(
          target.alias === source.alias ? pathName(candidate.path) : target.alias,
          used,
        );
        const enteredName = (
          await ask(`Forward reference name [${defaultName}]: `)
        ).trim();
        const name = enteredName || defaultName;
        used.add(name);

        let inverse: InverseRelationChoice | undefined;
        if (
          await askYesNo(
            `Add inverse relation on ${target.alias}?`,
            true,
            ask,
          )
        ) {
          const relationUsed =
            usedRelationNames.get(target.alias) ?? new Set<string>();
          usedRelationNames.set(target.alias, relationUsed);
          const relationDefault = uniqueName(pluralize(source.alias), relationUsed);
          const entered = (
            await ask(`Inverse relation name [${relationDefault}]: `)
          ).trim();
          const relationName = entered || relationDefault;
          relationUsed.add(relationName);

          const groupOptions = [
            "none",
            ...source.groupFields.map(
              (field) => `${field.path} (${field.values.join(", ")})`,
            ),
          ];
          const group = await chooseIndex(
            `Group ${target.alias}.${relationName} counts by a field?`,
            groupOptions,
            0,
            ask,
          );
          inverse = {
            name: relationName,
            ...(group > 0
              ? { groupBy: source.groupFields[group - 1]!.path }
              : {}),
          };
        }

        choices.push({
          source: source.alias,
          path: candidate.path,
          target: target.alias,
          name,
          ...(inverse ? { inverse } : {}),
        });
      }
    }
  } finally {
    rl.close();
  }
  return choices;
}

function candidateLabel(candidate: ReferenceCandidate): string {
  return candidate.kind === "strongRef"
    ? `a strongRef at ${candidate.path} (hydration resolves the current record by URI, not the pinned CID)`
    : `an AT URI at ${candidate.path}`;
}
