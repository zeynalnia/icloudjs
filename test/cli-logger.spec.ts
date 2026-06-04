/**
 * StderrCliLogger — ensures CLI diagnostics go to stderr only (never stdout),
 * and that the level is quiet by default / full under `--verbose`.
 */
import { StderrCliLogger } from '../src/cli/cli-logger';

describe('StderrCliLogger', () => {
  let stderr: jest.SpyInstance;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it('NEVER writes to stdout (quiet mode)', () => {
    const log = new StderrCliLogger(false);
    log.warn('w');
    log.error('e');
    log.debug('d');
    log.log('l');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('NEVER writes to stdout (verbose mode)', () => {
    const log = new StderrCliLogger(true);
    log.debug('d');
    log.log('l');
    log.verbose('v');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('quiet by default: emits warn/error to stderr, drops debug/log/verbose', () => {
    const log = new StderrCliLogger(false);
    log.debug('d', 'Ctx');
    log.log('l');
    log.verbose('v');
    expect(stderr).not.toHaveBeenCalled();

    log.warn('careful', 'Ctx');
    log.error('boom');
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stderr.mock.calls[0][0]).toBe('[WARN] [Ctx] careful\n');
    expect(stderr.mock.calls[1][0]).toBe('[ERROR] boom\n');
  });

  it('verbose: emits debug/log/verbose to stderr too', () => {
    const log = new StderrCliLogger(true);
    log.debug('detail', 'Http');
    log.log('info');
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stderr.mock.calls[0][0]).toBe('[DEBUG] [Http] detail\n');
    expect(stderr.mock.calls[1][0]).toBe('[LOG] info\n');
  });
});
