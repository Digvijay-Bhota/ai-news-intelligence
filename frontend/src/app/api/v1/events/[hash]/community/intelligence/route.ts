import { NextRequest } from 'next/server';
import { proxyCommunityApi } from '../../../../../../../utils/community-bff';

export const runtime = 'edge';

export async function GET(request: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return proxyCommunityApi(request, `/api/v1/events/${hash}/community/intelligence`, 'GET', 'public, s-maxage=300');
}
