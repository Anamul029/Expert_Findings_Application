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
export class Qualification {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @ManyToOne(() => Category, (category) => category.qualifications, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'category_id' })
  category!: Category;

  // inverse side of Expert M:N via expert_qualifications pivot
  @ManyToMany(() => Expert, (expert) => expert.qualifications)
  experts?: Expert[];
}
