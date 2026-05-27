const createPreset = require('conventional-changelog-conventionalcommits').default;

module.exports = createPreset({
  types: [
    { type: 'feat', section: 'Features' },
    { type: 'fix', section: 'Bug Fixes' },
    { type: 'UX', section: 'Improvements' },
    { type: 'perf', section: 'Performance Optimizations' },
    { type: 'docs', section: 'Documentation Updates' },
    { type: 'chore', section: 'Miscellaneous tasks' },
    { type: 'CI', section: 'CI Changes' },
    { type: 'revert', section: 'Reverts' },
    { type: 'refactor', section: 'Internal Changes' },
    { type: 'BREAKING', section: 'BREAKING CHANGES' },
  ]
});
