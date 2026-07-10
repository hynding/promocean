export function isValidUserId(userId: string): boolean {
  return userId.length >= 1 && userId.length <= 128
}
