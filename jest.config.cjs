module.exports = {
  testEnvironment: "jsdom",
  moduleNameMapper: {
    "\\.(css|less|scss|sass)$": "<rootDir>/test/__mocks__/styleMock.js",
    "\\.(png|jpg|jpeg|gif|svg)$": "<rootDir>/test/__mocks__/fileMock.js"
  },
  transformIgnorePatterns: ["<rootDir>/static/dist/"],
  setupFilesAfterEnv: ["<rootDir>/test/setupTests.js"]
};
