import React from 'react';
import { AlertCircleIcon } from './icons';

export function ErrorState({ message, onRetry }: { message: string, onRetry?: () => void }) {
  return (
    <div className="bg-red-50 border-l-4 border-red-500 p-6 rounded-r-lg my-8 w-full">
      <div className="flex items-start">
        <AlertCircleIcon className="h-6 w-6 text-red-500 mr-3 shrink-0 mt-0.5" />
        <div>
          <h3 className="text-lg font-medium text-red-800">Unable to load feed</h3>
          <p className="mt-2 text-sm text-red-700">{message}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-4 bg-red-100 text-red-800 hover:bg-red-200 px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
