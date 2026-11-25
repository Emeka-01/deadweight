import { cleanEnv, str } from "envalid";
export const env = cleanEnv(process.env, { SCHEMA_KEY: str() });
export const get = (name: string) => process.env[name];
