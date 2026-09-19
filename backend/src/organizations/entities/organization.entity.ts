import { Expert } from 'src/experts/entities/expert.entity';
import { Column, Entity, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Organization {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  type!: string;

  // inverse side of Expert M:N via expert_organizations pivot
  @ManyToMany(() => Expert, (expert) => expert.organizations)
  experts?: Expert[];
}
