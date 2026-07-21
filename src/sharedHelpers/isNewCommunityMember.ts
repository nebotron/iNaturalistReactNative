export const NEW_COMMUNITY_MEMBER_DAYS = 30;

const NEW_COMMUNITY_MEMBER_MS = NEW_COMMUNITY_MEMBER_DAYS * 24 * 60 * 60 * 1000;

export interface UserWithJoinDate {
  created_at?: string;
  createdAt?: string;
}

export const getUserCreatedAt = (
  user?: UserWithJoinDate | null,
): string | undefined => (
  user?.created_at || user?.createdAt
);

export const isNewCommunityMember = (
  user?: UserWithJoinDate | null,
  now = Date.now( ),
): boolean => {
  const createdAt = getUserCreatedAt( user );
  if ( !createdAt ) {
    return false;
  }

  const joinedDate = new Date( createdAt );
  if ( Number.isNaN( joinedDate.getTime( ) ) ) {
    return false;
  }

  return now - joinedDate.getTime( ) <= NEW_COMMUNITY_MEMBER_MS;
};
