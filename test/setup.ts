import nock from 'nock';

// Block all real network access during tests; mocks must explicitly allow.
nock.disableNetConnect();

afterEach(() => {
  nock.cleanAll();
});
