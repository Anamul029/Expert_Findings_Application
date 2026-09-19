import { Expert } from 'src/experts/entities/expert.entity';
import { Column, Entity, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Language {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  name!: string;

  // inverse side of Expert M:N via expert_languages pivot
  @ManyToMany(() => Expert, (expert) => expert.languages)
  experts?: Expert[];
}
