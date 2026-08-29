import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrganizationTable1700000000000 implements MigrationInterface {
  name = 'CreateOrganizationTable1700000000000';

  public async up(queryRunner: QueryRunner): Promise<any> {
    await queryRunner.query(`
        CREATE TABLE organizations (
          id            BIGSERIAL PRIMARY KEY,
          name          TEXT NOT NULL,
          type          TEXT
      );
        `);

    await queryRunner.query(`
      CREATE INDEX idx_organizations_name ON organizations(lower(name));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS organizations;`);
  }
}
