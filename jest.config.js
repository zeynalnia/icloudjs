module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/index.ts', '!src/cli/main.ts'],
  coverageThreshold: {
    global: { branches: 70, functions: 80, lines: 80, statements: 80 },
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  // axios-cookiejar-support and http-cookie-agent ship pure ESM. The CommonJS
  // test runner can't load them as-is, so transpile both (plus our TS) to CJS
  // via ts-jest. isolatedModules = transpile-only (full type-checking still
  // happens in `npm run build`); allowJs lets ts-jest process the deps' .js.
  transform: {
    '^.+\\.[cm]?[tj]s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(?:axios-cookiejar-support|http-cookie-agent|agent-base)/)',
  ],
  clearMocks: true,
  restoreMocks: true,
};
