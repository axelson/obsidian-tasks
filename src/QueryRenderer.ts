import { App, Keymap, MarkdownRenderChild, MarkdownRenderer, Plugin, TFile } from 'obsidian';
import type { EventRef, MarkdownPostProcessorContext } from 'obsidian';

import type { IQuery } from './IQuery';
import { State } from './Cache';
import { getTaskLineAndFile, replaceTaskWithTasks } from './File';
import type { GroupDisplayHeading } from './Query/GroupDisplayHeading';
import { TaskModal } from './TaskModal';
import type { TasksEvents } from './TasksEvents';
import type { Task } from './Task';
import { DateFallback } from './DateFallback';
import { TaskLayout } from './TaskLayout';
import { explainResults, getQueryForQueryRenderer } from './lib/QueryRendererHelper';

export class QueryRenderer {
    private readonly app: App;
    private readonly events: TasksEvents;

    constructor({ plugin, events }: { plugin: Plugin; events: TasksEvents }) {
        this.app = plugin.app;
        this.events = events;

        plugin.registerMarkdownCodeBlockProcessor('tasks', this._addQueryRenderChild.bind(this));
    }

    public addQueryRenderChild = this._addQueryRenderChild.bind(this);

    private async _addQueryRenderChild(source: string, element: HTMLElement, context: MarkdownPostProcessorContext) {
        context.addChild(
            new QueryRenderChild({
                app: this.app,
                events: this.events,
                container: element,
                source,
                filePath: context.sourcePath,
            }),
        );
    }
}

class QueryRenderChild extends MarkdownRenderChild {
    private readonly app: App;
    private readonly events: TasksEvents;
    private readonly source: string; // The complete text in the instruction block, such as 'not done\nshort mode'
    private readonly filePath: string; // The path of the file that contains the instruction block
    private query: IQuery;
    private queryType: string;

    private renderEventRef: EventRef | undefined;
    private queryReloadTimeout: NodeJS.Timeout | undefined;

    constructor({
        app,
        events,
        container,
        source,
        filePath,
    }: {
        app: App;
        events: TasksEvents;
        container: HTMLElement;
        source: string;
        filePath: string;
    }) {
        super(container);

        this.app = app;
        this.events = events;
        this.source = source;
        this.filePath = filePath;

        // The engine is chosen on the basis of the code block language. Currently
        // there is only the main engine for the plugin, this allows others to be
        // added later.
        switch (this.containerEl.className) {
            case 'block-language-tasks':
                this.query = getQueryForQueryRenderer(this.source);
                this.queryType = 'tasks';
                break;

            default:
                this.query = getQueryForQueryRenderer(this.source);
                this.queryType = 'tasks';
                break;
        }
    }

    onload() {
        // Process the current cache state:
        this.events.triggerRequestCacheUpdate(this.render.bind(this));
        // Listen to future cache changes:
        this.renderEventRef = this.events.onCacheUpdate(this.render.bind(this));

        this.reloadQueryAtMidnight();
    }

    onunload() {
        if (this.renderEventRef !== undefined) {
            this.events.off(this.renderEventRef);
        }

        if (this.queryReloadTimeout !== undefined) {
            clearTimeout(this.queryReloadTimeout);
        }
    }

    /**
     * Reloads the query after midnight to update results from relative date queries.
     *
     * For example, the query `due today` changes every day. This makes sure that all query results
     * are re-rendered after midnight every day to ensure up-to-date results without having to
     * reload obsidian. Creating a new query object from the source re-applies the relative dates
     * to "now".
     */
    private reloadQueryAtMidnight(): void {
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        const now = new Date();

        const millisecondsToMidnight = midnight.getTime() - now.getTime();

        this.queryReloadTimeout = setTimeout(() => {
            this.query = getQueryForQueryRenderer(this.source);
            // Process the current cache state:
            this.events.triggerRequestCacheUpdate(this.render.bind(this));
            this.reloadQueryAtMidnight();
        }, millisecondsToMidnight + 1000); // Add buffer to be sure to run after midnight.
    }

    private async render({ tasks, state }: { tasks: Task[]; state: State }) {
        // Don't log anything here, for any state, as it generates huge amounts of
        // console messages in large vaults, if Obsidian was opened with any
        // notes with tasks code blocks in Reading or Live Preview mode.

        const content = this.containerEl.createEl('div');
        if (state === State.Warm && this.query.error === undefined) {
            console.debug(
                `Render ${this.queryType} called for a block in active file "${this.filePath}", to select from ${tasks.length} tasks: plugin state: ${state}`,
            );

            if (this.query.layoutOptions.explainQuery) {
                this.createExplanation(content);
            }

            const tasksSortedLimitedGrouped = this.query.applyQueryToTasks(tasks);
            for (const group of tasksSortedLimitedGrouped.groups) {
                // If there were no 'group by' instructions, group.groupHeadings
                // will be empty, and no headings will be added.
                this.addGroupHeadings(content, group.groupHeadings);

                const { taskList } = await this.createTasksList({
                    tasks: group.tasks,
                    content: content,
                });
                content.appendChild(taskList);
            }
            const totalTasksCount = tasksSortedLimitedGrouped.totalTasksCount();
            console.debug(`${totalTasksCount} of ${tasks.length} tasks displayed in a block in "${this.filePath}"`);
            this.addTaskCount(content, totalTasksCount);
        } else if (this.query.error !== undefined) {
            content.createDiv().innerHTML =
                '<pre>' + `Tasks query: ${this.query.error.replace(/\n/g, '<br>')}` + '</pre>';
        } else {
            content.setText('Loading Tasks ...');
        }

        this.containerEl.firstChild?.replaceWith(content);
    }

    // Use the 'explain' instruction to enable this
    private createExplanation(content: HTMLDivElement) {
        const explanationAsString = explainResults(this.source);

        const explanationsBlock = content.createEl('pre');
        explanationsBlock.addClasses(['plugin-tasks-query-explanation']);
        explanationsBlock.setText(explanationAsString);
        content.appendChild(explanationsBlock);
    }

    private async createTasksList({
        tasks,
        content,
    }: {
        tasks: Task[];
        content: HTMLDivElement;
    }): Promise<{ taskList: HTMLUListElement; tasksCount: number }> {
        const tasksCount = tasks.length;

        const layout = new TaskLayout(this.query.layoutOptions);
        const taskList = content.createEl('ul');
        taskList.addClasses(['contains-task-list', 'plugin-tasks-query-result']);
        taskList.addClasses(layout.specificClasses);
        const groupingAttribute = this.getGroupingAttribute();
        if (groupingAttribute && groupingAttribute.length > 0) taskList.dataset.taskGroupBy = groupingAttribute;
        for (let i = 0; i < tasksCount; i++) {
            const task = tasks[i];
            const isFilenameUnique = this.isFilenameUnique({ task });

            const listItem = await task.toLi({
                parentUlElement: taskList,
                listIndex: i,
                layoutOptions: this.query.layoutOptions,
                isFilenameUnique,
                taskLayout: layout,
                obsidianComponent: this,
            });

            // Remove all footnotes. They don't re-appear in another document.
            const footnotes = listItem.querySelectorAll('[data-footnote-id]');
            footnotes.forEach((footnote) => footnote.remove());

            const shortMode = this.query.layoutOptions.shortMode;

            const extrasSpan = listItem.createSpan('task-extras');

            if (!this.query.layoutOptions.hideUrgency) {
                this.addUrgency(extrasSpan, task);
            }

            if (!this.query.layoutOptions.hideBacklinks) {
                this.addBacklinks(extrasSpan, task, shortMode, isFilenameUnique);
            }

            if (!this.query.layoutOptions.hideEditButton) {
                this.addEditButton(extrasSpan, task);
            }

            taskList.appendChild(listItem);
        }

        return { taskList, tasksCount };
    }

    private addEditButton(listItem: HTMLElement, task: Task) {
        const editTaskPencil = listItem.createEl('a', {
            cls: 'tasks-edit',
        });
        editTaskPencil.onClickEvent((event: MouseEvent) => {
            event.preventDefault();

            const onSubmit = (updatedTasks: Task[]): void => {
                replaceTaskWithTasks({
                    originalTask: task,
                    newTasks: DateFallback.removeInferredStatusIfNeeded(task, updatedTasks),
                });
            };

            // Need to create a new instance every time, as cursor/task can change.
            const taskModal = new TaskModal({
                app: this.app,
                task,
                onSubmit,
            });
            taskModal.open();
        });
    }

    private addUrgency(listItem: HTMLElement, task: Task) {
        const text = new Intl.NumberFormat().format(task.urgency);
        listItem.createSpan({ text, cls: 'tasks-urgency' });
    }

    /**
     * Display headings for a group of tasks.
     * @param content
     * @param groupHeadings - The headings to display. This can be an empty array,
     *                        in which case no headings will be added.
     * @private
     */
    private addGroupHeadings(content: HTMLDivElement, groupHeadings: GroupDisplayHeading[]) {
        for (const heading of groupHeadings) {
            this.addGroupHeading(content, heading);
        }
    }

    private async addGroupHeading(content: HTMLDivElement, group: GroupDisplayHeading) {
        // Headings nested to 2 or more levels are all displayed with 'h6:
        let header: keyof HTMLElementTagNameMap = 'h6';
        if (group.nestingLevel === 0) {
            header = 'h4';
        } else if (group.nestingLevel === 1) {
            header = 'h5';
        }

        const headerEl = content.createEl(header, {
            cls: 'tasks-group-heading',
        });
        await MarkdownRenderer.renderMarkdown(group.displayName, headerEl, this.filePath, this);
    }

    private addBacklinks(listItem: HTMLElement, task: Task, shortMode: boolean, isFilenameUnique: boolean | undefined) {
        const backLink = listItem.createSpan({ cls: 'tasks-backlink' });

        if (!shortMode) {
            backLink.append(' (');
        }

        const link = backLink.createEl('a');

        link.rel = 'noopener';
        link.target = '_blank';
        link.addClass('internal-link');
        if (shortMode) {
            link.addClass('internal-link-short-mode');
        }

        let linkText: string;
        if (shortMode) {
            linkText = ' 🔗';
        } else {
            linkText = task.getLinkText({ isFilenameUnique }) ?? '';
        }

        link.setText(linkText);

        // Go to the line the task is defined at
        const vault = this.app.vault;
        link.addEventListener('click', async (ev: MouseEvent) => {
            const result = await getTaskLineAndFile(task, vault);
            if (result) {
                const [line, file] = result;
                const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(ev));
                // This opens the file with the required line highlighted.
                // It works for Edit and Reading mode, however, for some reason (maybe an Obsidian bug),
                // when used in Reading mode, switching the result to Edit does not sync the scroll.
                // A patch suggested over Discord to use leaf.setEphemeralState({scroll: line}) does not seem
                // to make a difference.
                // The issue is tracked here: https://github.com/obsidian-tasks-group/obsidian-tasks/issues/1879
                await leaf.openFile(file, { eState: { line: line } });
            }
        });

        link.addEventListener('mousedown', async (ev: MouseEvent) => {
            // Open in a new tab on middle-click.
            // This distinction is not available in the 'click' event, so we handle the 'mousedown' event
            // solely for this.
            // (for regular left-click we prefer the 'click' event, and not to just do everything here, because
            // the 'click' event is more generic for touch devices etc.)
            if (ev.button === 1) {
                const result = await getTaskLineAndFile(task, vault);
                if (result) {
                    const [line, file] = result;
                    const leaf = this.app.workspace.getLeaf('tab');
                    await leaf.openFile(file, { eState: { line: line } });
                }
            }
        });

        if (!shortMode) {
            backLink.append(')');
        }
    }

    private addTaskCount(content: HTMLDivElement, tasksCount: number) {
        if (!this.query.layoutOptions.hideTaskCount) {
            content.createDiv({
                text: `${tasksCount} task${tasksCount !== 1 ? 's' : ''}`,
                cls: 'tasks-count',
            });
        }
    }

    private isFilenameUnique({ task }: { task: Task }): boolean | undefined {
        // Will match the filename without extension (the file's "basename").
        const filenameMatch = task.path.match(/([^/]*)\..+$/i);
        if (filenameMatch === null) {
            return undefined;
        }

        const filename = filenameMatch[1];
        const allFilesWithSameName = this.app.vault.getMarkdownFiles().filter((file: TFile) => {
            if (file.basename === filename) {
                // Found a file with the same name (it might actually be the same file, but we'll take that into account later.)
                return true;
            }
        });

        return allFilesWithSameName.length < 2;
    }

    private getGroupingAttribute() {
        const groupingRules: string[] = [];
        for (const group of this.query.grouping) {
            groupingRules.push(group.property);
        }
        return groupingRules.join(',');
    }
}
