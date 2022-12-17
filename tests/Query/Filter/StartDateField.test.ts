/**
 * @jest-environment jsdom
 */
import moment from 'moment';
import { toHaveExplanation } from '../../CustomMatchers/CustomMatchersForFilters';
import { StartDateField } from '../../../src/Query/Filter/StartDateField';
import { TaskBuilder } from '../../TestingTools/TaskBuilder';
import { expectTaskComparesAfter, expectTaskComparesBefore } from '../../CustomMatchers/CustomMatchersForSorting';
import { Sort } from '../../../src/Query/Sort';

window.moment = moment;

expect.extend({
    toHaveExplanation,
});

describe('explain start date queries', () => {
    it('should explain explicit date', () => {
        const filterOrMessage = new StartDateField().createFilterOrErrorMessage('starts before 2023-01-02');
        expect(filterOrMessage).toHaveExplanation(
            'start date is before 2023-01-02 (Monday 2nd January 2023) OR no start date',
        );
    });

    it('implicit "on" gets added to explanation, and it is clear that start date is optional', () => {
        const filterOrMessage = new StartDateField().createFilterOrErrorMessage('starts 2023-01-02');
        expect(filterOrMessage).toHaveExplanation(
            'start date is on 2023-01-02 (Monday 2nd January 2023) OR no start date',
        );
    });
});

describe('sorting by start', () => {
    it('supports Field sorting methods correctly', () => {
        const field = new StartDateField();
        expect(field.supportsSorting()).toEqual(false);
    });

    // These are minimal tests just to confirm basic behaviour is set up for this field.
    // Thorough testing is done in DueDateField.test.ts.

    const date1 = new TaskBuilder().startDate('2021-01-12').build();
    const date2 = new TaskBuilder().startDate('2022-12-23').build();

    it('sort by start', () => {
        expectTaskComparesBefore(Sort.makeLegacySorting(false, 1, 'start'), date1, date2);
    });

    it('sort by start reverse', () => {
        expectTaskComparesAfter(Sort.makeLegacySorting(true, 1, 'start'), date1, date2);
    });
});
