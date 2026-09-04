import { Price } from 'src/prices/entities/price.entity';
import { Qualification } from 'src/qualifications/entities/qualification.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum CategoryStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity()
export class Category {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string;

  @Column({
    type: 'enum',
    enum: CategoryStatus,
    default: CategoryStatus.ACTIVE,
  })
  status!: CategoryStatus;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at!: Date;

  @Column({ type: 'int', nullable: true })
  parent_id!: number | null;

  @ManyToOne(() => Category, (category) => category.children, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'parent_id' })
  parent!: Category;

  @OneToMany(() => Category, (category) => category.parent)
  children!: Category[];

  @OneToMany(() => Qualification, (qualification) => qualification.category)
  qualifications!: Qualification[];

  @OneToMany(() => Price, (prices) => prices.category)
  prices!: Price[];
}
