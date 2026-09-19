import { Category } from 'src/categories/entities/category.entity';
import { Expert } from 'src/experts/entities/expert.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export class Price {
  @PrimaryGeneratedColumn()
  id!: number;

  //   hourly, per-consultation, yearly, monthly etc...
  @Column({ type: 'varchar', nullable: true })
  type!: string | null;

  @Column({ type: 'int' })
  fee!: number;

  @ManyToOne(() => Category, (category) => category.prices, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'category_id' })
  category!: Category;

  // inverse side of Expert M:N via expert_prices pivot
  @ManyToMany(() => Expert, (expert) => expert.prices)
  experts?: Expert[];
}
