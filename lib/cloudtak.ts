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
    links: Type.Optional(Type.Array(CoreEventLink)),
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

/**
 * CoreEvent calls back into CloudTAK, authenticated as the Layer
 */
export default class CoreEvents {
    task: Pick<ETL, 'fetch' | 'type'>;

    constructor(task: Pick<ETL, 'fetch' | 'type'>) {
        this.task = task;
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
