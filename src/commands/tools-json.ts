import { operations } from '../core/operations.ts';
import { filterVoltMindMvpOperations } from '../core/mvp-surface.ts';

export function printToolsJson() {
  const tools = filterVoltMindMvpOperations(operations).map(op => ({
    name: op.name,
    description: op.description,
    parameters: Object.fromEntries(
      Object.entries(op.params).map(([k, v]) => [
        k,
        `${v.type}${v.required ? '' : '?'}`,
      ]),
    ),
  }));

  console.log(JSON.stringify(tools, null, 2));
}
