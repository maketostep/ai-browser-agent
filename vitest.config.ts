import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Браузерные тесты поднимают настоящий Chrome: дефолтных 5 секунд им мало.
    testTimeout: 60000,
    hookTimeout: 60000,
    // Один профиль Chrome нельзя открыть дважды одновременно.
    fileParallelism: false,
  },
});
