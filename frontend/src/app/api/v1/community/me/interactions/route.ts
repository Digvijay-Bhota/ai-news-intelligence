import { NextRequest } from 'next/server';
import { proxyCommunityApi } from '../../../../../../utils/community-bff';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const search = request.nextUrl.search;
  return proxyCommunityApi(request, `/api/v1/community/me/interactions${search}`, 'GET', 'private, no-store');
}
