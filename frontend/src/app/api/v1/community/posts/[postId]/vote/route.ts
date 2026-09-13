import { NextRequest } from 'next/server';
import { proxyCommunityApi } from '../../../../../../../utils/community-bff';

export const runtime = 'edge';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  return proxyCommunityApi(request, `/api/v1/community/posts/${postId}/vote`, 'PUT');
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  return proxyCommunityApi(request, `/api/v1/community/posts/${postId}/vote`, 'DELETE');
}
