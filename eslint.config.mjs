import security from "eslint-plugin-security";

export default [
  {
    ignores: ["node_modules/"],
  },
  {
    files: ["src/**/*.js", "cli/**/*.mjs", "bin/**/*.mjs"],
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
];
