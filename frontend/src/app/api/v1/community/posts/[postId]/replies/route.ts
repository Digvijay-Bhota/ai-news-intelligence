import { NextRequest } from 'next/server';
import { proxyCommunityApi } from '../../../../../../../utils/community-bff';

export const runtime = 'edge';

export async function GET(request: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  return proxyCommunityApi(request, `/api/v1/community/posts/${postId}/replies`, 'GET', 'public, s-maxage=60');
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  return proxyCommunityApi(request, `/api/v1/community/posts/${postId}/replies`, 'POST');
}
