import { type PluginContext } from "@lmstudio/sdk";
import { configSchematics } from "./configSchematics";
import { toolsProvider } from "./toolsProvider";

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withToolsProvider(toolsProvider);
}
