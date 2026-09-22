/** Печатает, какой провайдер и какие возможности выбраны. Секретов не выводит. */
import { resolve } from "../src/agent/provider.js";

process.loadEnvFile(".env");

const config = resolve();
console.log(`провайдер : ${config.label}`);
console.log(`baseURL   : ${config.baseURL ?? "(по умолчанию у SDK)"}`);
console.log(`модель    : ${config.mainModel}`);
console.log(`суб-агенты: ${config.subModel}`);
console.log(`ключ      : задан, ${config.apiKey.length} симв.`);
const off = Object.entries(config.features).filter(([, on]) => !on).map(([n]) => n);
console.log(`выключено : ${off.length ? off.join(", ") : "ничего"}`);
