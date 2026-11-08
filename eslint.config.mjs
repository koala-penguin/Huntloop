import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Every user-visible string must come from messages/{en,ko}.json.
    files: ["src/app/**/*.tsx", "src/components/**/*.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        {
          noStrings: false,
          ignoreProps: true,
          allowedStrings: ["·", "—", "–", "/", ":", ": ", "(", ")", "%", "$", "→", "←", "…", "×", "+", "-", "#", "|", "•"],
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "data/**", "test-results/**", "playwright-report/**"]),
]);

export default eslintConfig;
