import { render, screen, waitFor } from '@testing-library/react';
import { CommunityPulse } from '../src/components/CommunityPulse';
import { vi, describe, it, beforeEach, expect } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('CommunityPulse', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders multiple signals with correct semantic framing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          metrics: { lifetime_posts: 10, lifetime_participants: 5, posts_last_24h: 2, momentum_score: 3 },
          signals: [
            { type: 'emerging_theme', content: 'Theme 1', evidence_count: 5 },
            { type: 'common_question', content: 'Question 1', evidence_count: 3 },
            { type: 'divergent_view', content: 'View 1', evidence_count: 7 }
          ]
        }
      })
    });

    render(<CommunityPulse eventHash="hash1" />);

    await waitFor(() => {
      expect(screen.getByText('Several community members are discussing...')).toBeInTheDocument();
      expect(screen.getByText('"Theme 1"')).toBeInTheDocument();
      expect(screen.getByText('Based on 5 posts')).toBeInTheDocument();
      
      expect(screen.getByText('Common question emerging from the community...')).toBeInTheDocument();
      expect(screen.getByText('"Question 1"')).toBeInTheDocument();
      
      expect(screen.getByText('Divergent views are appearing around...')).toBeInTheDocument();
      expect(screen.getByText('"View 1"')).toBeInTheDocument();
    });
  });

  it('omits signal section when signals array is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          metrics: { lifetime_posts: 10 },
          signals: []
        }
      })
    });

    render(<CommunityPulse eventHash="hash2" />);

    await waitFor(() => {
      expect(screen.queryByText('Community Intelligence')).not.toBeInTheDocument();
    });
  });

  it('safely omits unknown signal types', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          metrics: { lifetime_posts: 10 },
          signals: [
            { type: 'unknown_type', content: 'Should not render', evidence_count: 1 }
          ]
        }
      })
    });

    render(<CommunityPulse eventHash="hash3" />);

    await waitFor(() => {
      expect(screen.queryByText('Should not render')).not.toBeInTheDocument();
      // It won't crash either
    });
  });

  it('gracefully degrades on backend failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { container } = render(<CommunityPulse eventHash="hash4" />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('never renders internal fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          metrics: { lifetime_posts: 10 },
          signals: [
            { 
              type: 'emerging_theme', 
              content: 'Valid content', 
              evidence_count: 5,
              id: 'INTERNAL_ID_123',
              event_id: 'EVENT_456',
              reviewer_id: 'REV_789',
              user_id: 'USER_999'
            }
          ]
        }
      })
    });

    render(<CommunityPulse eventHash="hash5" />);

    await waitFor(() => {
      expect(screen.getByText('"Valid content"')).toBeInTheDocument();
      expect(screen.queryByText('INTERNAL_ID_123')).not.toBeInTheDocument();
      expect(screen.queryByText('EVENT_456')).not.toBeInTheDocument();
      expect(screen.queryByText('REV_789')).not.toBeInTheDocument();
      expect(screen.queryByText('USER_999')).not.toBeInTheDocument();
    });
  });
});
