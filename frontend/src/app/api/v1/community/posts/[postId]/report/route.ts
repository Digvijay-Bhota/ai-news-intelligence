import { NextRequest } from 'next/server';
import { proxyCommunityApi } from '../../../../../../../utils/community-bff';

export const runtime = 'edge';

export async function POST(request: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  return proxyCommunityApi(request, `/api/v1/community/posts/${postId}/report`, 'POST');
}
