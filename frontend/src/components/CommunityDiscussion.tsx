'use client';
import React, { useState, useEffect } from 'react';

export function CommunityDiscussion({ eventHash }: { eventHash: string }) {
  const [posts, setPosts] = useState<any[]>([]);
  const [newPost, setNewPost] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, any[]>>({});
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({});

  const fetchPosts = async (cursor?: string) => {
    try {
      const url = cursor 
        ? `/api/v1/events/${eventHash}/community?cursor=${cursor}`
        : `/api/v1/events/${eventHash}/community`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load posts');
      const data = await res.json();
      if (data.success) {
        if (cursor) {
          setPosts(prev => [...prev, ...(data.data.items || [])]);
        } else {
          setPosts(data.data.items || []);
        }
        setNextCursor(data.data.next_cursor || null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading posts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPosts();
  }, [eventHash]);

  
  const fetchReplies = async (postId: string) => {
    try {
      const res = await fetch(`/api/v1/community/posts/${postId}/replies`);
      if (res.ok) {
        const d = await res.json();
        setReplies(prev => ({...prev, [postId]: d.data.items || []}));
      }
    } catch (e) {
      // ignore
    }
  };

  const handleToggleReplies = async (postId: string) => {
    if (expandedReplies[postId]) {
      setExpandedReplies(prev => ({...prev, [postId]: false}));
      return;
    }
    setExpandedReplies(prev => ({...prev, [postId]: true}));
    if (!replies[postId]) {
      await fetchReplies(postId);
    }
  };

  const handlePost = async () => {
    if (!newPost.trim()) return;
    try {
      const res = await fetch(`/api/v1/events/${eventHash}/community`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: newPost })
      });
      if (res.ok) {
        setNewPost('');
        setError(null);
        fetchPosts();
      } else {
        const d = await res.json();
        setError(d.error || 'Failed to post');
      }
    } catch (e) {
      setError('Network error');
    }
  };

  const handleReply = async (parentId: string) => {
    if (!replyBody.trim()) return;
    try {
      const res = await fetch(`/api/v1/community/posts/${parentId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: replyBody })
      });
      if (res.ok) {
        setReplyingId(null);
        setReplyBody('');
        setError(null);
        if (!expandedReplies[parentId]) {
          handleToggleReplies(parentId);
        } else {
          await fetchReplies(parentId);
        }
        fetchPosts();
      } else {
        const d = await res.json();
        setError(d.error || 'Failed to reply');
      }
    } catch (e) {
      setError('Network error');
    }
  };

  const handleEdit = async (postId: string) => {
    if (!editBody.trim()) return;
    try {
      const res = await fetch(`/api/v1/community/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editBody })
      });
      if (res.ok) {
        setEditingId(null);
        fetchPosts();
      } else {
        const d = await res.json();
        setError(d.error || 'Failed to edit');
      }
    } catch (e) {
      setError('Network error');
    }
  };

  const handleVote = async (postId: string, isUpvoted: boolean) => {
    try {
      await fetch(`/api/v1/community/posts/${postId}/vote`, {
        method: isUpvoted ? 'DELETE' : 'PUT'
      });
      fetchPosts();
    } catch (e) {
      setError('Network error');
    }
  };

  const handleDelete = async (postId: string) => {
    try {
      await fetch(`/api/v1/community/posts/${postId}`, { method: 'DELETE' });
      fetchPosts();
    } catch (e) {
      setError('Network error');
    }
  };
  
  const handleReport = async (postId: string) => {
    try {
      const res = await fetch(`/api/v1/community/posts/${postId}/report`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Inappropriate content' })
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error || 'Failed to report');
      }
    } catch (e) {
      setError('Network error');
    }
  };

  if (loading) return <div>Loading discussion...</div>;

  return (
    <div className="mt-8 border-t pt-8">
      <h2 className="text-xl font-bold mb-4">Community Discussion</h2>
      
      {error && <div className="text-red-500 mb-4 bg-red-100 p-2 rounded" role="alert">{error}</div>}

      <div className="mb-6">
        <textarea 
          className="w-full p-2 border rounded text-black"
          rows={3}
          value={newPost}
          onChange={e => setNewPost(e.target.value)}
          placeholder="Share your thoughts..."
          aria-label="New post"
        />
        <button 
          className="mt-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          onClick={handlePost}
        >
          Post
        </button>
      </div>

      <div className="space-y-4" role="list">
        {posts.map(post => (
          <div key={post.id} className="p-4 border rounded" role="listitem">
            <div className="flex justify-between items-start mb-2">
              <span className="font-semibold">{post.author_display_name}</span>
              <span className="text-sm text-gray-500">{new Date(post.created_at * 1000).toLocaleString()}</span>
            </div>
            
            {editingId === post.id ? (
              <div className="mb-3">
                <textarea 
                  className="w-full p-2 border rounded text-black"
                  value={editBody}
                  onChange={e => setEditBody(e.target.value)}
                  aria-label="Edit post"
                />
                <button onClick={() => handleEdit(post.id)} className="mr-2 text-blue-600">Save</button>
                <button onClick={() => setEditingId(null)} className="text-gray-600">Cancel</button>
              </div>
            ) : (
              <p className="whitespace-pre-wrap mb-3">{post.body}</p>
            )}
            
            <div className="flex space-x-4 text-sm">
              <button 
                className="text-gray-600 hover:text-blue-600"
                onClick={() => handleVote(post.id, false)}
                aria-label="Upvote"
              >
                👍 {post.upvotes}
              </button>
              <button 
                className="text-gray-600 hover:text-blue-600"
                onClick={() => { setReplyingId(post.id); setReplyBody(''); }}
              >
                Reply
              </button>
              {post.reply_count > 0 && (
                <button 
                  className="text-gray-600 hover:text-blue-600"
                  onClick={() => handleToggleReplies(post.id)}
                >
                  {expandedReplies[post.id] ? 'Hide Replies' : `View Replies (${post.reply_count})`}
                </button>
              )}
              <button 
                className="text-blue-600 hover:text-blue-800"
                onClick={() => { setEditingId(post.id); setEditBody(post.body); }}
              >
                Edit
              </button>
              <button 
                className="text-red-600 hover:text-red-800"
                onClick={() => handleDelete(post.id)}
              >
                Delete
              </button>
              <button 
                className="text-yellow-600 hover:text-yellow-800"
                onClick={() => handleReport(post.id)}
              >
                Report
              </button>
            </div>
            
                        {replyingId === post.id && (
              <div className="mt-3 ml-4 border-l-2 pl-4">
                <textarea 
                  className="w-full p-2 border rounded text-black mb-2"
                  value={replyBody}
                  onChange={e => setReplyBody(e.target.value)}
                  placeholder="Write a reply..."
                  aria-label="New reply"
                />
                <button onClick={() => handleReply(post.id)} className="mr-4 text-blue-600">Submit Reply</button>
                <button onClick={() => setReplyingId(null)} className="text-gray-600">Cancel</button>
              </div>
            )}
            
            {expandedReplies[post.id] && replies[post.id] && (
              <div className="mt-4 ml-6 space-y-3 border-l-2 border-gray-200 pl-4" role="list">
                {replies[post.id].map(reply => (
                  <div key={reply.id} className="p-2 border rounded bg-gray-50" role="listitem">
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-semibold text-sm">{reply.author_display_name}</span>
                      <span className="text-xs text-gray-500">{new Date(reply.created_at * 1000).toLocaleString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{reply.body}</p>
                    <div className="flex space-x-4 mt-2 text-xs">
                      <button 
                        className="text-gray-600 hover:text-blue-600"
                        onClick={() => handleVote(reply.id, false)}
                        aria-label="Upvote"
                      >
                        👍 {reply.upvotes}
                      </button>
                      {/* Replies cannot have replies (depth 1) so no reply button here */}
                      <button 
                        className="text-red-600 hover:text-red-800"
                        onClick={async () => {
                          await fetch(`/api/v1/community/posts/${reply.id}`, { method: 'DELETE' });
                          await fetchReplies(post.id);
                          fetchPosts();
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {posts.length === 0 && <p className="text-gray-500">No posts yet. Be the first to discuss this event!</p>}
        {nextCursor && (
          <button onClick={() => fetchPosts(nextCursor)} className="mt-4 px-4 py-2 bg-gray-200 text-black rounded">
            Load More
          </button>
        )}
      </div>
    </div>
  );
}
