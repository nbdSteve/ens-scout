module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    // Types are checked once by `npm run lint` (tsc --noEmit) over the same
    // tsconfig, so ts-jest transpiles without checking them again. Type-checking
    // aws-cdk-lib in every worker is most of this suite's runtime, and paying for it
    // twice reports the same error twice.
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.json', diagnostics: false, isolatedModules: true },
    ],
  },
};
