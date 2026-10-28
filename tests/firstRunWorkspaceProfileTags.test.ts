import { describe, expect, it } from 'vitest';
import {
	getWorkspaceProfileStarterTags,
	mergeWorkspaceProfileStarterTags
} from '../src/templates/firstRunWorkspaceProfiles';

describe('workspace profile starter tags', () => {
	it('uses tags from the selected profile templates', () => {
		expect(getWorkspaceProfileStarterTags('personal-cognitive')).toEqual([
			'daily',
			'ideas',
			'review',
			'concepts',
			'people',
			'projects',
			'resources'
		]);
		expect(getWorkspaceProfileStarterTags('financial')).toEqual([
			'budget',
			'investments',
			'accounts',
			'taxes',
			'goals',
			'receipts',
			'reports'
		]);
		expect(getWorkspaceProfileStarterTags('health-medical')).toEqual([
			'visits',
			'sleep',
			'labs',
			'nutrition',
			'training',
			'plans',
			'questions',
			'research',
			'outputs'
		]);
	});

	it('preserves existing tags and appends only tags that are not already present', () => {
		const existingTags = ['custom/tag', 'budget', ' Finance/Account '];

		expect(mergeWorkspaceProfileStarterTags(existingTags, 'financial')).toEqual([
			'custom/tag',
			'budget',
			' Finance/Account ',
			'investments',
			'accounts',
			'taxes',
			'goals',
			'receipts',
			'reports'
		]);
		expect(existingTags).toEqual(['custom/tag', 'budget', ' Finance/Account ']);
	});
});
