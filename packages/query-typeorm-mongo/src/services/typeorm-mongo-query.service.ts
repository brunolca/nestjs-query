import {
  AggregateQuery,
  AggregateResponse,
  Class,
  DeepPartial,
  DeleteManyResponse,
  Filter,
  Query,
  QueryService,
  UpdateManyResponse,
} from '@nestjs-query/core';
import { Logger, NotFoundException } from '@nestjs/common';
import { FindConditions, MongoRepository } from 'typeorm';

const mongoOperatorMapper: { [k: string]: string } = {
  eq: '$eq',
  neq: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  notIn: '$nin',
};

/**
 * Base class for all query services that use a `typeorm` Repository.
 *
 * @example
 *
 * ```ts
 * @QueryService(TodoItemEntity)
 * export class TodoItemService extends TypeOrmQueryService<TodoItemEntity> {
 *   constructor(
 *      @InjectRepository(TodoItemEntity) repo: Repository<TodoItemEntity>,
 *   ) {
 *     super(repo);
 *   }
 * }
 * ```
 */
export class TypeOrmMongoQueryService<Entity> implements QueryService<Entity> {
  protected readonly logger = new Logger(TypeOrmMongoQueryService.name);

  constructor(readonly repo: MongoRepository<Entity>) {}

  // eslint-disable-next-line @typescript-eslint/naming-convention
  get EntityClass(): Class<Entity> {
    return this.repo.target as Class<Entity>;
  }

  protected buildExpression(filter: Filter<Entity>): FindConditions<Entity> {
    return Object.entries(filter).reduce((prev: FindConditions<Entity>, [key, value]) => {
      if (!value) {
        return prev;
      }
      if (Array.isArray(value)) {
        return {
          ...prev,
          [`$${key}`]: value.map((subFilter) => this.buildExpression(subFilter)),
        };
      }
      const findConditions = Object.entries(value).reduce(
        (prevCondition: FindConditions<Entity>, [fieldKey, fieldValue]) => {
          if (mongoOperatorMapper[fieldKey]) {
            return {
              ...prevCondition,
              [mongoOperatorMapper[fieldKey]]: fieldValue,
            };
          }
          this.logger.error(`Operator ${fieldKey} not supported yet`);
          return prevCondition;
        },
        {},
      );
      return {
        ...prev,
        [key]: findConditions,
      };
    }, {});
  }

  /**
   * Query for multiple entities, using a Query from `@nestjs-query/core`.
   *
   * @example
   * ```ts
   * const todoItems = await this.service.query({
   *   filter: { title: { eq: 'Foo' } },
   *   paging: { limit: 10 },
   *   sorting: [{ field: "create", direction: SortDirection.DESC }],
   * });
   * ```
   * @param query - The Query used to filter, page, and sort rows.
   */
  query(query: Query<Entity>): Promise<Entity[]> {
    return this.repo.find({
      where: this.buildExpression(query.filter || {}),
      skip: query.paging?.offset,
      take: query.paging?.limit,
    });
  }

  aggregate(filter: Filter<Entity>, aggregate: AggregateQuery<Entity>): Promise<AggregateResponse<Entity>> {
    throw new Error('Not implemented yet');
  }

  count(filter: Filter<Entity>): Promise<number> {
    return this.repo.count(this.buildExpression(filter));
  }

  /**
   * Find an entity by it's `id`.
   *
   * @example
   * ```ts
   * const todoItem = await this.service.findById(1);
   * ```
   * @param id - The id of the record to find.
   */
  async findById(id: string): Promise<Entity | undefined> {
    return this.repo.findOne(id);
  }

  /**
   * Gets an entity by it's `id`. If the entity is not found a rejected promise is returned.
   *
   * @example
   * ```ts
   * try {
   *   const todoItem = await this.service.getById(1);
   * } catch(e) {
   *   console.error('Unable to find entity with id = 1');
   * }
   * ```
   * @param id - The id of the record to find.
   */
  async getById(id: string): Promise<Entity> {
    const entity = await this.findById(id);
    if (!entity) {
      throw new NotFoundException(`Unable to find ${this.EntityClass.name} with id: ${id}`);
    }
    return entity;
  }

  /**
   * Creates a single entity.
   *
   * @example
   * ```ts
   * const todoItem = await this.service.createOne({title: 'Todo Item', completed: false });
   * ```
   * @param record - The entity to create.
   */
  async createOne<C extends DeepPartial<Entity>>(record: C): Promise<Entity> {
    const entity = await this.ensureIsEntityAndDoesNotExist(record);
    return this.repo.save(entity);
  }

  /**
   * Create multiple entities.
   *
   * @example
   * ```ts
   * const todoItem = await this.service.createMany([
   *   {title: 'Todo Item 1', completed: false },
   *   {title: 'Todo Item 2', completed: true },
   * ]);
   * ```
   * @param records - The entities to create.
   */
  async createMany<C extends DeepPartial<Entity>>(records: C[]): Promise<Entity[]> {
    const entities = await Promise.all(records.map((r) => this.ensureIsEntityAndDoesNotExist(r)));
    return this.repo.save(entities);
  }

  /**
   * Update an entity.
   *
   * @example
   * ```ts
   * const updatedEntity = await this.service.updateOne(1, { completed: true });
   * ```
   * @param id - The `id` of the record.
   * @param update - A `Partial` of the entity with fields to update.
   */
  async updateOne<U extends DeepPartial<Entity>>(id: string, update: U): Promise<Entity> {
    this.ensureIdIsNotPresent(update);
    const entity = await this.repo.findOneOrFail(id);
    return this.repo.save(this.repo.merge(entity, update));
  }

  /**
   * Update multiple entities with a `@nestjs-query/core` Filter.
   *
   * @example
   * ```ts
   * const { updatedCount } = await this.service.updateMany(
   *   { completed: true }, // the update to apply
   *   { title: { eq: 'Foo Title' } } // Filter to find records to update
   * );
   * ```
   * @param update - A `Partial` of entity with the fields to update
   * @param filter - A Filter used to find the records to update
   */
  async updateMany<U extends DeepPartial<Entity>>(update: U, filter: Filter<Entity>): Promise<UpdateManyResponse> {
    this.ensureIdIsNotPresent(update);
    const res = await this.repo.updateMany(this.buildExpression(filter), { $set: update });
    return { updatedCount: res.result.nModified || 0 };
  }

  /**
   * Delete an entity by `id`.
   *
   * @example
   *
   * ```ts
   * const deletedTodo = await this.service.deleteOne(1);
   * ```
   *
   * @param id - The `id` of the entity to delete.
   */
  async deleteOne(id: string | number): Promise<Entity> {
    const entity = await this.repo.findOneOrFail(id);
    return this.repo.remove(entity);
  }

  /**
   * Delete multiple records with a `@nestjs-query/core` `Filter`.
   *
   * @example
   *
   * ```ts
   * const { deletedCount } = this.service.deleteMany({
   *   created: { lte: new Date('2020-1-1') }
   * });
   * ```
   *
   * @param filter - A `Filter` to find records to delete.
   */
  async deleteMany(filter: Filter<Entity>): Promise<DeleteManyResponse> {
    const res = await this.repo.deleteMany(this.buildExpression(filter));
    return { deletedCount: res.deletedCount || 0 };
  }

  private async ensureIsEntityAndDoesNotExist(e: DeepPartial<Entity>): Promise<Entity> {
    if (!(e instanceof this.EntityClass)) {
      return this.ensureEntityDoesNotExist(this.repo.create(e));
    }
    return this.ensureEntityDoesNotExist(e);
  }

  private async ensureEntityDoesNotExist(e: Entity): Promise<Entity> {
    if (this.repo.hasId(e)) {
      const found = await this.repo.findOne(this.repo.getId(e));
      if (found) {
        throw new Error('Entity already exists');
      }
    }
    return e;
  }

  private ensureIdIsNotPresent(e: DeepPartial<Entity>): void {
    if (this.repo.hasId((e as unknown) as Entity)) {
      throw new Error('Id cannot be specified when updating');
    }
  }

  /**
   * Adds multiple relations.
   * @param relationName - The name of the relation to query for.
   * @param id - The id of the dto to add the relation to.
   * @param relationIds - The ids of the relations to add.
   */
  addRelations<Relation>(relationName: string, id: string | number, relationIds: (string | number)[]): Promise<Entity> {
    throw new Error('Not implemented yet');
  }

  aggregateRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    entities: Entity[],
    filter: Filter<Relation>,
    aggregate: AggregateQuery<Relation>,
  ): Promise<Map<Entity, AggregateResponse<Relation>>>;

  aggregateRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity,
    filter: Filter<Relation>,
    aggregate: AggregateQuery<Relation>,
  ): Promise<AggregateResponse<Relation>>;

  aggregateRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity | Entity[],
    filter: Filter<Relation>,
    aggregate: AggregateQuery<Relation>,
  ): Promise<AggregateResponse<Relation> | Map<Entity, AggregateResponse<Relation>>> {
    throw new Error('Not implemented yet');
  }

  countRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    entities: Entity[],
    filter: Filter<Relation>,
  ): Promise<Map<Entity, number>>;

  countRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity,
    filter: Filter<Relation>,
  ): Promise<number>;

  countRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity | Entity[],
    filter: Filter<Relation>,
  ): Promise<number | Map<Entity, number>> {
    throw new Error('Not implemented yet');
  }

  findRelation<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dtos: Entity[],
  ): Promise<Map<Entity, Relation | undefined>>;
  findRelation<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity,
  ): Promise<Relation | undefined>;
  async findRelation<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity | Entity[],
  ): Promise<(Relation | undefined) | Map<Entity, Relation | undefined>> {
    const dtos: Entity[] = Array.isArray(dto) ? dto : [dto];
    const relationRepo = this.repo.manager.getRepository(RelationClass);
    return dtos.reduce(async (prev, curr) => {
      const map = await prev;
      map.set(curr, await relationRepo.findOne(curr[relationName as keyof Entity]));
      return map;
    }, Promise.resolve(new Map<Entity, Relation | undefined>()));
  }

  queryRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    entities: Entity[],
    query: Query<Relation>,
  ): Promise<Map<Entity, Relation[]>>;
  queryRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity,
    query: Query<Relation>,
  ): Promise<Relation[]>;
  queryRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity | Entity[],
    query: Query<Relation>,
  ): Promise<Relation[] | Map<Entity, Relation[]>> {
    throw new Error('Not implemented yet');
  }

  removeRelation<Relation>(relationName: string, id: string | number, relationId: string | number): Promise<Entity> {
    throw new Error('Not implemented yet');
  }

  removeRelations<Relation>(
    relationName: string,
    id: string | number,
    relationIds: (string | number)[],
  ): Promise<Entity> {
    throw new Error('Not implemented yet');
  }

  setRelation<Relation>(relationName: string, id: string | number, relationId: string | number): Promise<Entity> {
    throw new Error('Not implemented yet');
  }
}
