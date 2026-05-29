import createPreset from 'conventional-changelog-conventionalcommits';

export default createPreset({
  types: [
    { type: 'feat', section: 'Features' },
    { type: 'fix', section: 'Bug Fixes' },
    { type: 'UX', section: 'Improvements' },
    { type: 'perf', section: 'Performance Optimizations' },
    { type: 'docs', section: 'Documentation Updates' },
    { type: 'chore', section: 'Miscellaneous/infrastructure tasks' },
    { type: 'test', section: 'Test Coverage' }
    { type: 'CI', section: 'CI Changes' },
    { type: 'revert', section: 'Reverts' },
    { type: 'refactor', section: 'Internal Changes' },
    { type: 'BREAKING', section: 'BREAKING CHANGES' }
  ]
});
