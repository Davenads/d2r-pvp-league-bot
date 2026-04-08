// Discord channel IDs for the D2R 1v1 League server.
// These are non-sensitive snowflake IDs — safe to commit.

export const CHANNELS = {
  // Mod-only
  modLogs:       '1491240646168543322', // 1v1-mod-logs
  modQueue:      '1491240699876868116', // 1v1-mod-queue

  // Player-facing (bot posts here)
  queue:         '1491240398268403934', // 1v1-queue
  matchResults:  '1491240439708123228', // 1v1-match-results
  leaderboard:   '1491240333005033492', // 1v1-leaderboard
  matchThreads:  '1491240507672629479', // 1v1-match-threads (thread parent)
  announcements: '1491240168294977617', // 1v1-announcements
  signUpHere:    '1491240371173196049', // 1v1-sign-up-here
} as const;

export type ChannelKey = keyof typeof CHANNELS;
