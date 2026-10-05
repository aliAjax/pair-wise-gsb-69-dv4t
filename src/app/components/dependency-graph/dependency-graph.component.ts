import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  ChangeRequest,
  RESOURCE_LABELS,
  ResourceType,
} from '../../models/change-request.model';

interface GraphNode {
  id: string;
  name: string;
  type: ResourceType;
  critical: boolean;
  x: number;
  y: number;
}

interface GraphEdge {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  missing: boolean;
}

@Component({
  selector: 'app-dependency-graph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="graph-toolbar">
      <div>
        <strong>{{ resources().length }}</strong>
        <span>个资源节点</span>
      </div>
      <div>
        <strong>{{ edges().length }}</strong>
        <span>条依赖关系</span>
      </div>
      <div class="legend">
        <span class="legend-dot critical"></span>关键资源
        <span class="legend-dot missing"></span>缺失依赖
      </div>
    </div>

    <div class="graph-canvas">
      <svg viewBox="0 0 920 420" role="img" aria-label="资源依赖关系图">
        @for (edge of edges(); track edge.id) {
          <line
            [attr.x1]="edge.x1"
            [attr.y1]="edge.y1"
            [attr.x2]="edge.x2"
            [attr.y2]="edge.y2"
            [class.missing-edge]="edge.missing"
          />
        }
        @for (node of nodes(); track node.id) {
          <g [attr.transform]="'translate(' + node.x + ',' + node.y + ')'">
            <rect
              width="150"
              height="62"
              rx="4"
              [class.critical-node]="node.critical"
            />
            <text x="14" y="24" class="node-name">{{ node.name }}</text>
            <text x="14" y="45" class="node-type">
              {{ label(node.type) }} · {{ node.id }}
            </text>
          </g>
        }
      </svg>
      @if (!resources().length) {
        <p class="empty">添加资源后生成依赖图。</p>
      }
    </div>
  `,
  styles: [
    `
      .graph-toolbar {
        display: flex;
        align-items: center;
        gap: 24px;
        padding: 12px 0 16px;
        color: #565656;
      }

      .graph-toolbar strong {
        color: #1b1b1b;
        font-size: 18px;
        margin-right: 4px;
      }

      .legend {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
        font-size: 12px;
      }

      .legend-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        margin-left: 10px;
      }

      .legend-dot.critical {
        background: #c21d00;
      }

      .legend-dot.missing {
        background: transparent;
        border: 2px solid #c21d00;
      }

      .graph-canvas {
        min-height: 420px;
        overflow: auto;
        border: 1px solid #d7d7d7;
        background: #fafafa;
      }

      svg {
        display: block;
        min-width: 760px;
        width: 100%;
      }

      line {
        stroke: #6f8aa3;
        stroke-width: 2;
      }

      line.missing-edge {
        stroke: #c21d00;
        stroke-dasharray: 6 5;
      }

      rect {
        fill: #ffffff;
        stroke: #6f8aa3;
        stroke-width: 1.5;
      }

      rect.critical-node {
        stroke: #c21d00;
        stroke-width: 2;
      }

      text {
        pointer-events: none;
      }

      .node-name {
        fill: #1b1b1b;
        font-size: 13px;
        font-weight: 600;
      }

      .node-type {
        fill: #666666;
        font-size: 10px;
      }

      .empty {
        padding: 32px;
        text-align: center;
        color: #737373;
      }
    `,
  ],
})
export class DependencyGraphComponent {
  readonly change = input.required<ChangeRequest>();

  readonly nodes = computed<GraphNode[]>(() => {
    const resources = this.change().resources;
    const grouped = new Map<ResourceType, typeof resources>();
    resources.forEach((resource) => {
      const group = grouped.get(resource.type) ?? [];
      group.push(resource);
      grouped.set(resource.type, group);
    });

    const types: ResourceType[] = ['datacenter', 'rack', 'network', 'storage', 'service'];
    const result: GraphNode[] = [];
    types.forEach((type, column) => {
      (grouped.get(type) ?? []).forEach((resource, row) => {
        result.push({
          id: resource.id,
          name: resource.name,
          type: resource.type,
          critical: resource.critical,
          x: 40 + column * 175,
          y: 42 + (row % 4) * 86,
        });
      });
    });
    return result;
  });

  readonly edges = computed<GraphEdge[]>(() => {
    const nodes = new Map(this.nodes().map((node) => [node.id, node]));
    return this.change().resources.flatMap((resource) =>
      resource.dependencies.map((dependencyId) => {
        const source = nodes.get(dependencyId);
        const target = nodes.get(resource.id);
        if (!source || !target) {
          const fallback = target ?? { x: 770, y: 42 };
          return {
            id: `${resource.id}-${dependencyId}`,
            x1: fallback.x,
            y1: fallback.y + 31,
            x2: fallback.x,
            y2: fallback.y + 31,
            missing: true,
          };
        }
        return {
          id: `${resource.id}-${dependencyId}`,
          x1: source.x + 150,
          y1: source.y + 31,
          x2: target.x,
          y2: target.y + 31,
          missing: false,
        };
      }),
    );
  });

  readonly resources = computed(() => this.change().resources);

  label(type: ResourceType): string {
    return RESOURCE_LABELS[type];
  }
}
