export { MarkdownParser } from "./markdown-parser.js";
export { YAMLConfigParser } from "./yaml-parser.js";
export { JSONConfigParser } from "./json-parser.js";
export { TOMLParser } from "./toml-parser.js";
export { EnvParser } from "./env-parser.js";
export { DockerfileParser } from "./dockerfile-parser.js";
export { SQLParser } from "./sql-parser.js";
export { GraphQLParser } from "./graphql-parser.js";
export { ProtobufParser } from "./protobuf-parser.js";
export { TerraformParser } from "./terraform-parser.js";
export { MakefileParser } from "./makefile-parser.js";
export { ShellParser } from "./shell-parser.js";
import type { PluginRegistry } from "../registry.js";
/**
 * Register all built-in non-code parsers with a PluginRegistry.
 */
export declare function registerAllParsers(registry: PluginRegistry): void;
//# sourceMappingURL=index.d.ts.map