import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type ETL from '@tak-ps/etl';

export const CoreEventLink = Type.Object({
    name: Type.String(),
    url: Type.String()
});

export type Link = Static<typeof CoreEventLink>;

// Subset of CloudTAK's CoreEventResponse this task relies on - carried by event:<action> messages
export const IncidentEvent = Type.Object({
    id: Type.String(),
    name: Type.String(),
    type: Type.String(),
    created: Type.String(),
    priority: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    remarks: Type.Optional(Type.String()),
    ended: Type.Optional(Type.Union([Type.Null(), Type.String()], { description: 'Time at which the Event ends - a future time keeps it active until then' })),
    links: Type.Optional(Type.Array(CoreEventLink)),
    boards: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        column: Type.Union([Type.Null(), Type.String()], { description: 'null when the Event is not placed on the Board' })
    }))),
    geometry: Type.Object({
        type: Type.Literal('Point'),
        coordinates: Type.Array(Type.Number())
    })
});

export type IncidentEvent = Static<typeof IncidentEvent>;

// Subset of CloudTAK's CoreEventBoardEventResponse this task relies on
export const Placement = Type.Object({
    id: Type.String(),
    board: Type.String(),
    event: IncidentEvent
});

const CoreEventLinks = Type.Object({
    links: Type.Array(CoreEventLink)
});

export const Assignment = Type.Object({
    id: Type.String(),
    name: Type.String(),
    uid: Type.Union([Type.Null(), Type.String()]),
    role: Type.String()
});

const AssignmentList = Type.Object({
    items: Type.Array(Assignment)
});

export const Priority = Type.Union([
    Type.Literal('none'),
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
    Type.Literal('critical')
]);

export type Priority = Static<typeof Priority>;

/** Has the Event ended - a future `ended` keeps it active until then */
export function closed(event: Pick<IncidentEvent, 'ended'>): boolean {
    return !!event.ended && Date.parse(event.ended) <= Date.now();
}

/**
 * CoreEvent calls back into CloudTAK, authenticated as the Layer
 */
export default class CoreEvents {
    task: Pick<ETL, 'fetch' | 'type'>;

    constructor(task: Pick<ETL, 'fetch' | 'type'>) {
        this.task = task;
    }

    json(body: object): { method: string, headers: Record<string, string>, body: string } {
        return {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        };
    }

    /** End the Event now, or clear its end so it is active again */
    async setActive(event: string, active: boolean): Promise<void> {
        await this.task.fetch(`/api/core/event/${event}`, this.json({ active }));
    }

    async setPriority(event: string, priority: Priority): Promise<void> {
        await this.task.fetch(`/api/core/event/${event}`, this.json({ priority }));
    }

    async assignments(event: string): Promise<Array<Static<typeof Assignment>>> {
        return this.task.type(AssignmentList, await this.task.fetch(`/api/core/event/${event}/assignment?limit=100`)).items;
    }

    /** Assign a person by name - without a CloudTAK Profile the uid is left unset */
    async assign(event: string, name: string, remarks: string): Promise<void> {
        await this.task.fetch(`/api/core/event/${event}/assignment`, {
            ...this.json({ name, role: '', remarks }),
            method: 'POST'
        });
    }

    /** PATCH replaces the links array, so append only the links not already present by URL or name */
    async link(event: string, links: Array<{ name: string, url: string }>): Promise<void> {
        const current = this.task.type(CoreEventLinks, await this.task.fetch(`/api/core/event/${event}`));

        const missing = links.filter((link) => {
            return !current.links.some((l) => l.url === link.url || l.name === link.name);
        });

        if (!missing.length) return;

        await this.task.fetch(`/api/core/event/${event}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                links: [...current.links, ...missing]
            })
        });
    }
}
