import { type PluginContext } from "@lmstudio/sdk";
import { configSchematics } from "./configSchematics";
import { promptPreprocessor } from "./promptPreprocessor";
import { toolsProvider } from "./toolsProvider";

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withPromptPreprocessor(promptPreprocessor);
  context.withToolsProvider(toolsProvider);
}
